// 桌宠事件桥 (主窗口侧): 会话事实快照推给桌宠窗口 + 接收桌宠窗口的变更回传
//
// 只在开启桌宠时由 store/pet.ts 动态 import 并启动, 关闭时整体释放 —— 桌宠关着的时候,
// 主窗口里一个会话订阅、一个事件监听都不挂。配置的读写仍在 store, 这里只管"桥"。
//
// 信号层 (pet_signals) 只提炼事实 —— 几个会话在跑、谁做完了没人看、谁在等审批、有没有刚报错,
// 宠物据此怎么演由桌宠窗口的大脑决定, 这里不掺任何表现逻辑。
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionStore, type SessionState } from "../store/session";
import { useThemeStore } from "../store/theme";
import {
  pushConfig,
  usePetStore,
  type PetActivate,
  type PetPatch,
  type PetSignals,
} from "../store/pet";

/** 气泡里叫得出口的会话名: 会话标题 → 工作目录最后一段 → 兜底 */
function sessionLabel(s: SessionState): string {
  return s.sessionName?.trim() || s.cwd.split(/[\\/]/).filter(Boolean).pop() || "会话";
}

/**
 * 启动事件桥, 返回释放函数。等所有监听都注册完才返回: 调用方紧接着就开窗,
 * 抢跑的话桌宠窗口的 pet_ready 握手会打在还没注册的监听上直接丢掉
 */
export async function startBridge(): Promise<() => void> {
  // 待看完成: sessionId → 完成时刻。Map 保持插入序, 即完成先后。
  // 不能直接用 hasUnread: 它只在"完成时用户没选中该会话"才置位, 用户选中着会话但人不在
  // (主窗口失焦 / 最小化) 时完成就漏了, 所以这里自己记, hasUnread 只当清除条件之一
  const pending = new Map<string, number>();
  let errorSeq = 0;
  // 人在不在主窗口前: 窗口聚焦 + 页面可见, 两个都满足才算在看。实测 WebView2 最小化时
  // onFocusChanged(false) 可靠, visibilityState 却仍是 visible —— 判定靠聚焦, 可见性只是别的平台的兜底
  let winFocused = document.hasFocus();
  const present = () => winFocused && document.visibilityState === "visible";
  // 上次推送的快照序列化: 每个 text_delta 都会触发 store 变更, 内容没变就不发, 否则每秒几十次 IPC
  let lastSignals = "";

  const pushSignals = (force = false) => {
    const { sessions, activeSessionId } = useSessionStore.getState();
    // 移出待看: 会话已关闭; 或人在主窗口前、停在该会话上、未读也已清掉 (= 用户确实看到了)
    for (const id of [...pending.keys()]) {
      const s = sessions[id];
      if (!s || (present() && activeSessionId === id && !s.hasUnread)) pending.delete(id);
    }
    const list = Object.values(sessions);
    const snap: PetSignals = {
      running: list.filter((s) => s.isStreaming).length,
      pending: [...pending].map(([sessionId, at]) => ({
        sessionId,
        name: sessionLabel(sessions[sessionId]),
        at,
      })),
      waiting: list
        .filter((s) => s.uiRequests.length > 0)
        .map((s) => ({ sessionId: s.sessionId, name: sessionLabel(s) })),
      errorSeq,
    };
    const key = JSON.stringify(snap);
    if (!force && key === lastSignals) return;
    lastSignals = key;
    if (import.meta.env.DEV) console.debug("[pet] signals", snap);
    emitTo("pet", "pet_signals", snap).catch(() => {});
  };

  const onVisibility = () => pushSignals();
  document.addEventListener("visibilitychange", onVisibility);

  const offs: Array<() => void> = [() => document.removeEventListener("visibilitychange", onVisibility)];

  // 会话状态变化 → 重算并按需推送 (pushSignals 内部做了去重)
  offs.push(useSessionStore.subscribe(() => pushSignals()));

  // 切日间/夜间 / 换强调色 → 重推配置, 让气泡跟着换色。setMode / setAccent 都是先写完
  // data-base / 强调色 token 才 set, 所以这里读到的已经是新配色的值
  offs.push(
    useThemeStore.subscribe((s, prev) => {
      if (s.resolved !== prev.resolved || s.accent !== prev.accent) pushConfig();
    }),
  );

  offs.push(
    ...(await Promise.all([
      // 只读事件不调 handleEvent, 不会让 session store 双跑 (那是 main.tsx 的活)
      listen<{ sessionId: string; event: Record<string, unknown> }>("pi_event", (e) => {
        const { sessionId, event: ev } = e.payload;
        // 工具报错是瞬时事件, store 状态里留不下"刚刚发生"的痕迹, 只能在这里捕获
        if (ev.type === "tool_execution_end" && ev.isError) {
          errorSeq++;
          pushSignals();
        }
        // 完成判定挂在 agent_settled 而不是 isStreaming 的下降沿: 停止会话 / 进程退出 / detach
        // 也会把 isStreaming 置 false, 那些不是"做完了"。agent_settled 正是 hasUnread 的置位时机,
        // 这里判同一组条件再加上"人不在", 与 main.tsx 里 handleEvent 谁先跑都不影响结果
        if (ev.type === "agent_settled") {
          const { activeSessionId } = useSessionStore.getState();
          if (activeSessionId !== sessionId || !present()) {
            pending.delete(sessionId); // 重复完成按最新时刻排队
            pending.set(sessionId, Date.now());
          }
          pushSignals();
        }
      }),
      getCurrentWindow().onFocusChanged(({ payload }) => {
        winFocused = payload;
        pushSignals();
      }),
      // 桌宠窗口挂载完成 → 回推配置与当前快照 (强推: 新开的窗口不知道之前推过什么)。
      // 开窗瞬间就推的话, 窗口还没挂载完, 事件会丢
      listen("pet_ready", () => {
        pushConfig();
        pushSignals(true);
      }),
      // 单击桌宠 → 呼出主窗口并切到该会话 (等审批的 / 最早做完的)
      listen<PetActivate>("pet_activate", async (e) => {
        const { sessionId } = e.payload;
        pending.delete(sessionId);
        await invoke("focus_main_window").catch((err) => console.error("[pet] 呼出主窗口失败", err));
        const store = useSessionStore.getState();
        const s = store.sessions[sessionId];
        if (s) {
          // 与侧边栏点会话同一调用序列: 先切 (秒显缓存), detached 的后台重连
          store.setActiveSession(sessionId);
          if (s.detached && s.sessionPath) void store.reattachSession(sessionId, s.cwd, s.sessionPath);
        }
        pushSignals();
      }),
      // 桌宠窗口侧的变更回传 (滚轮缩放 / 拖动落点 / 右键切角色或关闭)
      listen<PetPatch>("pet_patch", (e) => usePetStore.getState().applyPatch(e.payload)),
    ])),
  );

  return () => offs.forEach((f) => f());
}
