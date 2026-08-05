import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore, pathEq } from "./projects";
import type { UiNotification, UiRequest } from "../lib/pi";

export interface ChatEntry {
  id: string;
  kind: "message" | "tool";
  role?: "user" | "assistant";
  text?: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  status?: "running" | "done" | "error";
  result?: unknown;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

// 单个 session 的完整状态 (M3: 多 session, 每个 session 独立)
export interface SessionState {
  sessionId: string;
  cwd: string;
  sessionPath: string | null; // 加载的历史会话文件 (新建会话为 null)
  sessionName: string | null; // get_state.sessionName
  isStreaming: boolean;
  entries: ChatEntry[];
  currentAssistantId: string | null;
  error: string | null;
  currentModel: ModelInfo | null;
  thinkingLevel: string;
  availableModels: ModelInfo[];
  availableThinkingLevels: string[];
  steeringQueue: string[];
  followUpQueue: string[];
  uiRequests: UiRequest[];      // extension_ui_request dialog 类请求队列 (FIFO, 一次弹一个)
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  tokenStats: {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    userMessages: number;
    assistantMessages: number;
    totalMessages: number;
  } | null;
  detached: boolean;            // pi 进程已停但 entries 仍在内存 (秒切缓存), 切回走 reattach
  hasUnread: boolean;           // 后台完成任务有新消息, 用户未看 (侧边栏显示点提醒)
  lastEntryMtime: number | null; // jsonl 文件 mtime baseline (mtime 守卫: 没变就不重读 entries)
}

interface SessionStore {
  sessions: Record<string, SessionState>;
  activeSessionId: string | null;
  sessionOrder: string[];
  isSwitching: boolean;

  startSession: (cwd: string, opts?: { provider?: string; model?: string; sessionPath?: string }) => Promise<string>;
  stopSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string) => void;
  sendPrompt: (sessionId: string, text: string, images?: unknown[]) => Promise<void>;
  // steer: agent 运行中排队指导消息; followUp: agent 停止后排队的后续消息
  // 队列内容由 pi queue_update 事件权威回推 (元素为纯字符串), 这里不做乐观插入
  sendSteer: (sessionId: string, text: string, images?: unknown[]) => Promise<void>;
  sendFollowUp: (sessionId: string, text: string, images?: unknown[]) => Promise<void>;
  abort: (sessionId: string) => Promise<void>;
  setModel: (sessionId: string, provider: string, modelId: string) => Promise<void>;
  cycleModel: (sessionId: string) => Promise<void>;
  setThinkingLevel: (sessionId: string, level: string) => Promise<void>;
  cycleThinkingLevel: (sessionId: string) => Promise<void>;
  loadState: (sessionId: string) => Promise<void>;
  loadModels: (sessionId: string) => Promise<void>;
  loadThinkingLevels: (sessionId: string) => Promise<void>;
  loadSessionStats: (sessionId: string) => Promise<void>;
  loadEntries: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, name: string) => Promise<void>;
  reattachSession: (sessionId: string, cwd: string, sessionPath: string) => Promise<void>;
  removeSessionState: (sessionId: string) => void;
  markDetached: (sessionId: string) => void;
  handleEvent: (payload: { sessionId: string; event: Record<string, unknown> }) => void;
  // extension_ui_request 响应: 乐观移出队列后写回 pi; 失败时 pi 侧超时自动解决, 不阻塞
  resolveUiRequest: (sessionId: string, id: string, payload: Record<string, unknown>) => Promise<void>;
  // notify 通知条 (全局, 跨会话展示)
  notifications: UiNotification[];
  dismissNotification: (id: string) => void;
}

// reattach 防竞态: 每次递增, 异步完成时比对, 不一致则丢弃 (快速连切时旧 reattach 不串到当前会话)
let reattachEpoch = 0;
// detached 会话 entries 常驻上限, 超限清最久未访问 (防长期使用内存无限增长)
const ENTRY_CACHE_LIMIT = 20;

export const useSessionStore = create<SessionStore>((set, get) => {
  // 更新指定 session 的部分字段 (闭包 helper, handleEvent/actions 复用)
  const patch = (sessionId: string, fields: Partial<SessionState>) =>
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...s, ...fields } } };
    });

  return {
    sessions: {},
    activeSessionId: null,
    sessionOrder: [],
    isSwitching: false,
    notifications: [],

    startSession: async (cwd, opts) => {
      // 切换中: 立即切掉旧消息内容, 消息区显示混沌 loading 动画 (startSession 慢操作期间不残留旧会话)
      set({ isSwitching: true });
      try {
        // Rust 首帧直读: 历史会话 entries 随 start_session 一并返回 (契约对齐 pi get_entries, 过滤 session 头),
        // 前端直接渲染, 不再等 get_entries RPC
        const sessionPath = opts?.sessionPath ?? null;
        const data = await invoke<{ sessionId: string; entries?: unknown[] }>("start_session", {
          cwd,
          provider: opts?.provider ?? null,
          model: opts?.model ?? null,
          sessionPath,
        });
        const id = data.sessionId;
        // Array.isArray 守卫直接收窄类型 (布尔中间变量无法把收窄传给后续使用)
        const rawEntries = Array.isArray(data.entries) ? data.entries : null;
        const entries = rawEntries ? mapHistoryEntries(rawEntries) : [];
        set((state) => ({
          sessions: {
            ...state.sessions,
            [id]: {
              sessionId: id, cwd, sessionPath, sessionName: null,
              isStreaming: false, entries, currentAssistantId: null,
              detached: false, lastEntryMtime: null, hasUnread: false,
              error: null, currentModel: null, thinkingLevel: "medium",
              availableModels: [], availableThinkingLevels: ["off"],
              steeringQueue: [], followUpQueue: [], uiRequests: [],
              contextUsage: null, tokenStats: null,
            },
          },
          activeSessionId: id,
          sessionOrder: [...state.sessionOrder.filter((sid) => sid !== id), id],
        }));
        const tasks: Promise<unknown>[] = [
          get().loadState(id),
          get().loadModels(id),
          get().loadThinkingLevels(id),
          get().loadSessionStats(id),
        ];
        // 直读路径同步 mtime baseline: reattach 的 mtime 守卫依赖它 (文件没变不重读)
        if (sessionPath) {
          tasks.push((async () => {
            try {
              const mtime = await invoke<number | null>("get_session_file_mtime", { sessionPath });
              patch(id, { lastEntryMtime: mtime });
            } catch { /* ignore */ }
          })());
        }
        // 历史会话兜底: Rust 直读 entries 意外缺失 (契约外) → 退回 get_entries 路径
        if (sessionPath && !rawEntries) tasks.push(get().loadEntries(id));
        await Promise.all(tasks);
        return id;
      } finally {
        set({ isSwitching: false });
      }
    },

    stopSession: async (sessionId) => {
      try { await invoke("stop_session", { sessionId }); } catch { /* ignore */ }
      // detach: 停 pi 进程但保留 entries (秒切缓存); sessionOrder 保留让侧边栏 openId 仍命中快路径
      // uiRequests 同步清空: 进程没了 pi 侧 pending 自动 reject, 前端不能留悬挂弹窗
      patch(sessionId, { detached: true, isStreaming: false, currentAssistantId: null, uiRequests: [] });
      // activeSessionId 若是被停的, 切到下一个非自己会话 (detached 也能秒切, 允许切到 detached)
      set((state) => {
        if (state.activeSessionId !== sessionId) return state;
        const next = state.sessionOrder.filter((sid) => sid !== sessionId).pop() ?? null;
        return { activeSessionId: next };
      });
      // prune: detached 会话超上限时清最久未访问 (sessionOrder 开头最旧)
      set((state) => {
        const detachedIds = state.sessionOrder.filter((sid) => state.sessions[sid]?.detached);
        if (detachedIds.length <= ENTRY_CACHE_LIMIT) return state;
        const toRemove = detachedIds.slice(0, detachedIds.length - ENTRY_CACHE_LIMIT);
        const sessions = { ...state.sessions };
        toRemove.forEach((sid) => delete sessions[sid]);
        const sessionOrder = state.sessionOrder.filter((sid) => !toRemove.includes(sid));
        const activeSessionId = toRemove.includes(state.activeSessionId ?? "")
          ? (sessionOrder[sessionOrder.length - 1] ?? null)
          : state.activeSessionId;
        return { sessions, sessionOrder, activeSessionId };
      });
    },

    // 真删前端 state (不调 invoke): 删会话文件 / 移除项目 / 关新会话节点用, 进程已由 stopSession 停
    removeSessionState: (sessionId) => {
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[sessionId];
        const sessionOrder = state.sessionOrder.filter((sid) => sid !== sessionId);
        const activeSessionId = state.activeSessionId === sessionId
          ? (sessionOrder[sessionOrder.length - 1] ?? null)
          : state.activeSessionId;
        return { sessions, sessionOrder, activeSessionId };
      });
    },

    // reattach: detached 会话切回时后台重建 pi 进程 (复用 warm), mtime 守卫决定是否重读 entries
    reattachSession: async (sessionId, cwd, sessionPath) => {
      const epoch = ++reattachEpoch;
      // 复用 start_session 传原 sessionId: Rust 侧 rebind 事件流到原 id, 缓存 entries 不用迁移 key
      try {
        await invoke("start_session", {
          cwd, provider: null, model: null, sessionPath, sessionId,
        });
      } catch (e) {
        patch(sessionId, { error: `重连会话失败: ${String(e)}` });
        return;
      }
      // 用户已切走 → 丢弃, 不 patch detached 避免串到当前会话
      if (epoch !== reattachEpoch) return;
      const cached = get().sessions[sessionId];
      if (!cached) return; // 已被真删
      // mtime 守卫: 磁盘没变就不 get_entries, 沿用缓存 entries (秒切核心), 只补 state/stats
      let mtime: number | null = null;
      try {
        mtime = await invoke<number | null>("get_session_file_mtime", { sessionPath });
      } catch { /* ignore */ }
      if (epoch !== reattachEpoch) return;
      const unchanged = mtime != null && cached.lastEntryMtime != null && mtime <= cached.lastEntryMtime;
      if (unchanged) {
        // 文件没变: 沿用缓存 entries, 只补 state/stats (pi 进程已 switch_session 内部就绪)
        await Promise.all([get().loadState(sessionId), get().loadSessionStats(sessionId)]);
      } else {
        // 文件变了或无 baseline: 重新读 entries (loadEntries 内部会更新 lastEntryMtime)
        await get().loadEntries(sessionId);
      }
      if (epoch !== reattachEpoch) return;
      patch(sessionId, { detached: false });
    },

    // LRU 淘汰 / 进程异常退出通知: 标记 detached, entries 保留 (秒切缓存), 切回走 reattach
    markDetached: (sessionId: string) => {
      patch(sessionId, { detached: true, isStreaming: false, currentAssistantId: null, uiRequests: [] });
    },

    setActiveSession: (sessionId) => set((state) => {
      const s = state.sessions[sessionId];
      // 切到该会话即视为已读, 清除未读标记 (侧边栏点 → 日期)
      return s?.hasUnread
        ? { activeSessionId: sessionId, sessions: { ...state.sessions, [sessionId]: { ...s, hasUnread: false } } }
        : { activeSessionId: sessionId };
    }),

    sendPrompt: async (sessionId, text, images) => {
      const s = get().sessions[sessionId];
      if (!s || !text.trim()) return;
      patch(sessionId, {
        entries: [...s.entries, { id: crypto.randomUUID(), kind: "message", role: "user", text }],
        isStreaming: true,
      });
      try {
        await invoke("send_prompt", { sessionId, message: text, images: images ?? null });
      } catch (e) {
        patch(sessionId, { isStreaming: false, error: String(e) });
      }
    },

    // steer/followUp 共用的发送骨架: 校验 session/文本/进程存活后 invoke 对应 command
    // detached 拒绝: 进程已停, 消息无处可投, 硬发只会悬挂 (写 error 让用户切回重连)
    sendSteer: async (sessionId, text, images) => {
      const s = get().sessions[sessionId];
      if (!s || !text.trim()) return;
      if (s.detached) { patch(sessionId, { error: "会话进程已停止, 请切回重连后再发送指导消息" }); return; }
      try {
        await invoke("send_steer", { sessionId, message: text.trim(), images: images ?? null });
      } catch (e) {
        patch(sessionId, { error: String(e) });
      }
    },

    sendFollowUp: async (sessionId, text, images) => {
      const s = get().sessions[sessionId];
      if (!s || !text.trim()) return;
      if (s.detached) { patch(sessionId, { error: "会话进程已停止, 请切回重连后再排队后续消息" }); return; }
      try {
        await invoke("send_follow_up", { sessionId, message: text.trim(), images: images ?? null });
      } catch (e) {
        patch(sessionId, { error: String(e) });
      }
    },

    abort: async (sessionId) => {
      try { await invoke("abort_session", { sessionId }); }
      catch (e) { patch(sessionId, { error: String(e) }); }
    },

    loadState: async (sessionId) => {
      try {
        const data = await invoke<Record<string, unknown>>("get_state", { sessionId });
        patch(sessionId, {
          currentModel: (data.model as ModelInfo) || null,
          thinkingLevel: (data.thinkingLevel as string) || "medium",
          // 新会话 spawn 后 get_state 即返回真实 sessionFile 路径 (文件在首次 prompt 后才落盘);
          // 有值才覆盖, 无值 (极端情况) 保留 startSession 传入的历史路径
          sessionPath: (data.sessionFile as string) || (get().sessions[sessionId]?.sessionPath ?? null),
        });
      } catch { /* ignore */ }
    },

    loadModels: async (sessionId) => {
      try {
        const data = await invoke<{ models: ModelInfo[] }>("get_available_models", { sessionId });
        patch(sessionId, { availableModels: data.models || [] });
      } catch { /* ignore */ }
    },

    setModel: async (sessionId, provider, modelId) => {
      try {
        const data = await invoke<ModelInfo>("set_model", { sessionId, provider, modelId });
        patch(sessionId, { currentModel: data });
        await get().loadThinkingLevels(sessionId);
      } catch (e) { patch(sessionId, { error: String(e) }); }
    },

    cycleModel: async (sessionId) => {
      try {
        const data = await invoke<{ model: ModelInfo; thinkingLevel: string } | null>("cycle_model", { sessionId });
        if (data?.model) patch(sessionId, { currentModel: data.model, thinkingLevel: data.thinkingLevel || get().sessions[sessionId]?.thinkingLevel || "medium" });
      } catch { /* ignore */ }
    },

    setThinkingLevel: async (sessionId, level) => {
      try { await invoke("set_thinking_level", { sessionId, level }); patch(sessionId, { thinkingLevel: level }); }
      catch (e) { patch(sessionId, { error: String(e) }); }
    },

    cycleThinkingLevel: async (sessionId) => {
      try {
        const data = await invoke<{ level: string } | null>("cycle_thinking_level", { sessionId });
        if (data?.level) patch(sessionId, { thinkingLevel: data.level });
      } catch { /* ignore */ }
    },

    loadThinkingLevels: async (sessionId) => {
      try {
        const data = await invoke<{ levels: string[] }>("get_available_thinking_levels", { sessionId });
        patch(sessionId, { availableThinkingLevels: data.levels || ["off"] });
      } catch { /* ignore */ }
    },

    loadSessionStats: async (sessionId) => {
      try {
        const data = await invoke<Record<string, unknown>>("get_session_stats", { sessionId });
        const cu = data.contextUsage as { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined;
        const tk = data.tokens as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | undefined;
        patch(sessionId, {
          contextUsage: cu ? {
            tokens: cu.tokens ?? null,
            contextWindow: cu.contextWindow ?? 0,
            percent: cu.percent ?? null,
          } : null,
          tokenStats: tk ? {
            tokens: {
              input: tk.input ?? 0, output: tk.output ?? 0,
              cacheRead: tk.cacheRead ?? 0, cacheWrite: tk.cacheWrite ?? 0,
              total: tk.total ?? 0,
            },
            cost: (data.cost as number) ?? 0,
            userMessages: (data.userMessages as number) ?? 0,
            assistantMessages: (data.assistantMessages as number) ?? 0,
            totalMessages: (data.totalMessages as number) ?? 0,
          } : null,
        });
      } catch { /* ignore */ }
    },

    loadEntries: async (sessionId) => {
      try {
        const data = await invoke<{ entries: unknown[] }>("get_entries", { sessionId });
        patch(sessionId, { entries: mapHistoryEntries(data.entries || []) });
        // 记录 mtime baseline: 下次切回走 mtime 守卫, 文件没变就不重读
        const sp = get().sessions[sessionId]?.sessionPath;
        if (sp) {
          try {
            const mtime = await invoke<number | null>("get_session_file_mtime", { sessionPath: sp });
            patch(sessionId, { lastEntryMtime: mtime });
          } catch { /* ignore */ }
        }
      } catch (e) {
        patch(sessionId, { error: `历史加载失败: ${String(e)}` });
      }
    },

    renameSession: async (sessionId, name) => {
      try {
        await invoke("set_session_name", { sessionId, name });
        patch(sessionId, { sessionName: name });
      } catch (e) {
        patch(sessionId, { error: String(e) });
      }
    },

    handleEvent: (payload) => {
      const { sessionId, event } = payload;
      const s = get().sessions[sessionId];
      if (!s) return;
      const type = event.type as string;
      switch (type) {
        case "agent_start":
          patch(sessionId, { isStreaming: true });
          break;
        case "message_start": {
          const msg = event.message as { role?: string; id?: string } | undefined;
          if (msg?.role === "assistant") {
            const id = msg.id || crypto.randomUUID();
            const cur = get().sessions[sessionId]!;
            patch(sessionId, {
              entries: [...cur.entries, { id, kind: "message", role: "assistant", text: "", thinking: "" }],
              currentAssistantId: id,
            });
          }
          break;
        }
        case "message_update": {
          const ev = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          const cur = get().sessions[sessionId];
          if (!cur || !cur.currentAssistantId || !ev?.delta) break;
          if (ev.type === "text_delta") {
            patch(sessionId, { entries: cur.entries.map((e) =>
              e.id === cur.currentAssistantId && e.kind === "message" ? { ...e, text: (e.text || "") + ev.delta! } : e
            )});
          } else if (ev.type === "thinking_delta") {
            patch(sessionId, { entries: cur.entries.map((e) =>
              e.id === cur.currentAssistantId && e.kind === "message" ? { ...e, thinking: (e.thinking || "") + ev.delta! } : e
            )});
          }
          break;
        }
        case "message_end":
          patch(sessionId, { currentAssistantId: null });
          break;
        case "tool_execution_start": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          patch(sessionId, { entries: [...cur.entries, {
            id: event.toolCallId as string, kind: "tool", toolCallId: event.toolCallId as string,
            toolName: event.toolName as string, args: event.args, status: "running",
          }]});
          break;
        }
        case "tool_execution_end": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          patch(sessionId, { entries: cur.entries.map((e) =>
            e.kind === "tool" && e.toolCallId === event.toolCallId
              ? { ...e, status: event.isError ? "error" : "done", result: event.result } : e
          )});
          break;
        }
        case "queue_update": {
          const q = event as { steering?: string[]; followUp?: string[] };
          patch(sessionId, { steeringQueue: q.steering || [], followUpQueue: q.followUp || [] });
          break;
        }
        case "agent_settled":
          patch(sessionId, { isStreaming: false, currentAssistantId: null });
          // 后台完成任务: 若用户没在看这个会话, 标记未读 (侧边栏圈圈→点提醒看)
          if (get().activeSessionId !== sessionId) {
            patch(sessionId, { hasUnread: true });
          }
          // 新会话落盘后刷新侧边栏: 首次 prompt 已把 session 文件写入磁盘, 重新扫描让
          // 侧边栏的"打开中"虚拟节点转正为历史会话节点 (磁盘列表已含则天然去重不刷)
          {
            const sp = get().sessions[sessionId]?.sessionPath;
            const inDisk = useProjectsStore.getState().projects.some((p) =>
              p.sessions.some((ds) => pathEq(ds.session_path, sp))
            );
            if (sp && !inDisk) {
              useProjectsStore.getState().loadProjects();
            }
          }
          break;
        case "pi_process_exit":
          patch(sessionId, { isStreaming: false, currentAssistantId: null, uiRequests: [], error: "pi 进程已退出" });
          break;
        // 扩展 UI 请求: dialog 类 (confirm/select/input/editor) 入队等待用户响应;
        // notify 是 fire-and-forget 信息条, 直接展示; 其余 (setStatus/setWidget/setTitle 等)
        // 桌面端无承载 V1 忽略
        case "extension_ui_request": {
          const req = event as unknown as UiRequest;
          const method = req.method;
          if (method === "confirm" || method === "select" || method === "input" || method === "editor") {
            const cur = get().sessions[sessionId];
            if (!cur) break;
            patch(sessionId, { uiRequests: [...cur.uiRequests, req] });
          } else if (method === "notify") {
            const n: UiNotification = {
              id: (req.id as string) || crypto.randomUUID(),
              message: (req.message as string) || "",
              notifyType: (req.notifyType as UiNotification["notifyType"]) || "info",
            };
            if (n.message) {
              set((state) => ({ notifications: [...state.notifications, n] }));
            }
          }
          break;
        }
      }
    },

    resolveUiRequest: async (sessionId, id, payload) => {
      // 乐观移除: 先出队再发 invoke, 用户无感知; 失败时 pi 侧 timeout 自动解决 (不跟踪)
      const cur = get().sessions[sessionId];
      if (cur) {
        patch(sessionId, { uiRequests: cur.uiRequests.filter((r) => r.id !== id) });
      }
      try {
        await invoke("send_extension_ui_response", { sessionId, id, payload });
      } catch (e) {
        patch(sessionId, { error: `响应扩展请求失败: ${String(e)}` });
      }
    },

    dismissNotification: (id) => {
      set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) }));
    },
  };
});

/**
 * get_entries 历史条目 → ChatEntry 映射 (纯函数, 便于测试)
 * message 条目: user 取 text 块拼接; assistant 拆 thinking/text/toolCall 块
 * 其余类型 (model_change 等) 忽略
 */
export function mapHistoryEntries(entries: unknown[]): ChatEntry[] {
  const result: ChatEntry[] = [];
  for (const raw of entries) {
    const e = raw as { id?: string; type?: string; message?: { role?: string; content?: unknown[] } };
    if (e.type !== "message" || !e.message) continue;
    const content = e.message.content ?? [];
    if (e.message.role === "user") {
      const text = content
        .filter((b) => (b as { type?: string }).type === "text")
        .map((b) => (b as { text?: string }).text ?? "")
        .join("");
      if (text) result.push({ id: e.id ?? crypto.randomUUID(), kind: "message", role: "user", text });
    } else if (e.message.role === "assistant") {
      let text = "";
      let thinking = "";
      for (const block of content) {
        const b = block as { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
        if (b.type === "text" && b.text) text += b.text;
        else if (b.type === "thinking" && b.thinking) thinking += b.thinking;
        else if (b.type === "toolCall") {
          // 历史里的工具调用: 无执行结果, 只展示调用参数
          result.push({
            id: b.id ?? crypto.randomUUID(), kind: "tool",
            toolCallId: b.id, toolName: b.name, args: b.arguments,
            status: "done", result: null,
          });
        }
      }
      if (text || thinking) {
        result.push({
          id: e.id ?? crypto.randomUUID(), kind: "message", role: "assistant",
          text, thinking: thinking || undefined,
        });
      }
    }
  }
  return result;
}