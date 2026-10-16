// 桌宠事件桥 (主窗口侧): 会话状态聚合推给桌宠窗口 + 接收桌宠窗口的变更回传
//
// 只在开启桌宠时由 store/pet.ts 动态 import 并启动, 关闭时整体释放 —— 桌宠关着的时候,
// 主窗口里一个会话订阅、一个事件监听都不挂。配置的读写仍在 store, 这里只管"桥"。
import { emitTo, listen } from "@tauri-apps/api/event";
import { useSessionStore, type SessionState } from "../store/session";
import { useThemeStore } from "../store/theme";
import { pushConfig, usePetStore, type PetPatch, type PetState } from "../store/pet";

// 覆盖态时长: greet 是开窗打招呼, error 是报错后的短暂定格
const GREET_MS = 2500;
const ERROR_MS = 2000;

/** 多会话聚合成单一状态 (全局聚合: 任一会话在忙, 桌宠就忙) */
function aggregate(sessions: Record<string, SessionState>): PetState {
  const list = Object.values(sessions);
  if (list.length === 0) return "offline";
  return list.some((s) => s.isStreaming) ? "busy" : "idle";
}

/**
 * 启动事件桥, 返回释放函数。等所有监听都注册完才返回: 调用方紧接着就开窗,
 * 抢跑的话桌宠窗口的 pet_ready 握手会打在还没注册的监听上直接丢掉
 */
export async function startBridge(): Promise<() => void> {
  // 时限性覆盖态: greet/error 不由 aggregate 推导, 到点自动撤销后重算
  let override: PetState | null = null;
  let overrideTimer: ReturnType<typeof setTimeout> | null = null;
  // 上次推给桌宠的值: 每个 text_delta 都会触发 store 变更, 不去重会变成每秒几十次 IPC
  let lastPushed: PetState | null = null;

  const pushState = () => {
    const next = override ?? aggregate(useSessionStore.getState().sessions);
    if (next === lastPushed) return;
    lastPushed = next;
    emitTo("pet", "pet_state", { state: next }).catch(() => {});
  };

  const setOverride = (state: PetState, ms: number) => {
    if (overrideTimer) clearTimeout(overrideTimer);
    override = state;
    pushState();
    overrideTimer = setTimeout(() => {
      override = null;
      overrideTimer = null;
      pushState();
    }, ms);
  };

  const offs: Array<() => void> = [];

  // 会话状态变化 → 重算并按需推送 (pushState 内部做了值去重)
  offs.push(useSessionStore.subscribe(() => pushState()));

  // 换皮肤 → 重推配置, 让气泡跟着换色。applyTheme 先写完 CSS 变量才 set activeSkinId,
  // 所以这里读到的已经是新皮肤的值
  offs.push(
    useThemeStore.subscribe((s, prev) => {
      if (s.activeSkinId !== prev.activeSkinId) pushConfig();
    }),
  );

  offs.push(
    ...(await Promise.all([
      // 工具报错是瞬时事件, store 状态里留不下"刚刚发生"的痕迹, 单独挂一个监听捕获。
      // 这里只读事件不调 handleEvent, 不会让 session store 双跑 (那是 main.tsx 的活)
      listen<{ sessionId: string; event: Record<string, unknown> }>("pi_event", (e) => {
        const ev = e.payload.event;
        if (ev.type === "tool_execution_end" && ev.isError) setOverride("error", ERROR_MS);
      }),
      // 桌宠窗口挂载完成 → 回推配置与当前状态。开窗瞬间就推的话, 窗口还没挂载完, 事件会丢
      listen("pet_ready", () => {
        pushConfig();
        lastPushed = null; // 强制下一次推送, 让新开的窗口拿到当前态
        setOverride("greet", GREET_MS);
      }),
      // 桌宠窗口侧的变更回传 (滚轮缩放 / 拖动落点 / 右键切角色或关闭)
      listen<PetPatch>("pet_patch", (e) => usePetStore.getState().applyPatch(e.payload)),
    ])),
  );

  return () => {
    offs.forEach((f) => f());
    if (overrideTimer) clearTimeout(overrideTimer);
  };
}
