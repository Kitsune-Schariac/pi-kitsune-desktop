import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore, pathEq } from "./projects";
import { useGitStore } from "./git";
import { hasTerminalMarkup, stripTerminalMarkup } from "../lib/sanitize";
import { startRound, dropSession, resetLive, noteDelta, settle, liveSpeedFor, finishRound } from "../lib/speedLive";
import type { UiNotification, UiRequest } from "../lib/pi";
import {
  PI_CAPABILITIES,
  normalizeAgentKind,
  type AgentCapabilities,
  type AgentEventPayload,
  type AgentKind,
  type PermissionRequest,
} from "../lib/agent";

// 每次 agent_start 自增的纪元号。prompt 的 disposition 回来时要靠它判断「这期间 pi 到底起没起 agent」:
// handled 只说明扩展命令把这条消息消费了, 但扩展也可能自己 pi.sendMessage() 起一轮 —— 那时
// agent_start 已经先到, 不能因为 handled 就把刚置上的运行中抹掉。abort 的兜底同理
const agentEpoch = new Map<string, number>();
const epochOf = (sessionId: string) => agentEpoch.get(sessionId) ?? 0;

export interface ChatEntry {
  id: string;
  kind: "message" | "tool" | "notification";
  role?: "user" | "assistant";
  text?: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  status?: "running" | "done" | "error";
  result?: unknown;
  // 舰队 stream 推导用: tool 调用起止时间 (epoch ms)。实时路径 Date.now(), 历史路径从
  // message.timestamp 解析。缺失/无效 → undefined (耗时显示 —)。非 tool 条目不填
  startedAt?: number;
  endedAt?: number;
  // notification 专用: info/warning/error, 决定图标 + 类型色 (会话内系统消息条目)
  notifyType?: "info" | "warning" | "error";
  // 实时 assistant 专用: 模型此刻在流式生成的内容块是工具调用参数。工具卡要等 message_end 之后的
  // tool_execution_start 才出现, 这段时间正文没有字在长, 时间线据此把等待提示换成「生成工具调用中」。
  // 只在内容块切换 (*_start) 时写, 每块一次; 历史回放不填
  draftingTool?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

/// 本轮 agent 运行的 usage 累计 (输入卡底部实时统计条用, 与跨会话的 TokenStatsPanel 无关)
/// 拆 committed / live 两组是被 pi 契约逼的: message_update 只给顶层 usage (当前这条消息的累计),
/// message_end 的 message.usage 才是该条消息的权威值 —— 直接累加 message_update 会把同一条消息重复计入
///
/// 速度统计 (genStartedAt / deltaCounts / speed / calls) 的依据见本任务 design.md:
/// 实测 provider 流式期间上报的 usage 恒为 0 (371 个 message_update 中仅 1 个非零),
/// 故实时值只能靠 delta 事件计数估算 —— text/thinking 的 delta 计数与 output token
/// 精确 1:1, toolcall 约 2.9:1 (JSON 参数), 估算误差实测 < 0.3%。
/// 字符数不能用来估算: 字符/token 比率随内容剧变 (文本 1.68 / 工具参数 0.75 / 中文 1.54 / 英文 4)。
export interface TurnStats {
  input: number;      // 已 message_end 的消息累加值
  output: number;
  cost: number;
  liveInput: number;  // 当前流式消息的实时量, message_end 时并入上面归零
  liveOutput: number;
  startedAt: number | null;
  elapsedMs: number | null; // null = 仍在跑; 有值 = 本轮已定格

  // ── 输出速度 (tok/s) ──
  genStartedAt: number | null;  // 当前调用首个 delta 到达时间 (null = 尚未开始生成)
  deltaCounts: DeltaCounts;     // 当前调用的 delta 计数 (实时估算用)
  speed: number | null;         // 当前速度: 流式中为估算值, settled 后为加权平均
  calls: CallRecord[];          // 本轮各次调用的结算记录 (算加权平均)

  // ── 缓存命中率 ──
  // 本轮最近一次调用的请求侧用量; null = 本轮尚无带 usage 的调用 (界面隐藏 CH)
  lastCache: LastCacheUsage | null;
  // 本轮是否出现过缓存活动。会话级累计 (get_session_stats) 是 CH 显示条件的主依据,
  // 但它只在 agent_settled 才刷新 —— 没有这个字段的话首轮流式全程看不到 CH。
  // provider 不支持缓存时它保持 false, CH 仍然隐藏。
  cacheSeen: boolean;
}

/**
 * 最近一次 LLM 调用的请求侧用量。
 *
 * 为什么不用会话级 tokenStats 算: 底部统计条整体是「本轮」语义, CH 必须随 agent_start 重置,
 * 否则新一轮开始时会显示上一轮的命中率; 而 tokenStats (get_session_stats) 是整会话累计。
 */
export interface LastCacheUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** delta 事件计数: text/thinking 与 output token 1:1, toolcall 约 2.9:1 */
export interface DeltaCounts {
  thinking: number;
  text: number;
  toolcall: number;
}

/** 一次 LLM 调用的结算记录 (权威值) */
export interface CallRecord {
  output: number;   // 该次调用的 output token
  window: number;   // 该次调用的生成窗口 (秒)
}

// 单个 session 的完整状态 (多 session + 多 Agent, 每个 session 独立)
export interface SessionState {
  sessionId: string;
  agentKind: AgentKind;
  capabilities: AgentCapabilities;
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
  permissionRequests: PermissionRequest[]; // 统一工具审批队列 (Claude can_use_tool / ACP request_permission)
  permissionMode: string | null;           // 当前权限模式 (如 Claude Code: auto / manual / acceptEdits / plan)
  remoteSessionId: string | null;          // 外部 CLI 会话 ID (Claude session_id / ACP sessionId)
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  tokenStats: {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    userMessages: number;
    assistantMessages: number;
    totalMessages: number;
  } | null;
  turnStats: TurnStats | null;  // 本轮运行统计 (null = 本会话还没跑过任何一轮)
  detached: boolean;            // pi 进程已停但 entries 仍在内存 (秒切缓存), 切回走 reattach
  hasUnread: boolean;           // 后台完成任务有新消息, 用户未看 (侧边栏显示点提醒)
  lastEntryMtime: number | null; // jsonl 文件 mtime baseline (mtime 守卫: 没变就不重读 entries)
}

interface SessionStore {
  sessions: Record<string, SessionState>;
  activeSessionId: string | null;
  sessionOrder: string[];
  isSwitching: boolean;

  startSession: (
    cwd: string,
    opts?: {
      agentKind?: AgentKind;
      provider?: string;
      model?: string;
      permissionMode?: string;
      sessionPath?: string;
    },
  ) => Promise<string>;
  stopSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string) => void;
  sendPrompt: (sessionId: string, text: string, images?: unknown[]) => Promise<void>;
  // steer: agent 运行中排队指导消息; followUp: agent 停止后排队的后续消息
  // 队列内容由后端 queue_update 事件权威回推 (元素为纯字符串), 这里不做乐观插入
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
  reattachSession: (sessionId: string, cwd: string, sessionPath: string, agentKind?: AgentKind) => Promise<void>;
  removeSessionState: (sessionId: string) => void;
  markDetached: (sessionId: string) => void;
  handleEvent: (payload: AgentEventPayload) => void;
  // 速度采样 (InputBar 的 1s tick 调): 实时值在模块级累加器里, 不经过 store 状态,
  // 所以用 action 读取而非 selector。返回 null = 无有效数据, 界面显示 —
  sampleSpeed: (sessionId: string) => number | null;
  // extension_ui_request 响应: 乐观移出队列后写回 pi; 失败时 pi 侧超时自动解决, 不阻塞
  resolveUiRequest: (sessionId: string, id: string, payload: Record<string, unknown>) => Promise<void>;
  // 统一工具审批响应 (Claude can_use_tool / ACP request_permission)
  respondPermission: (
    sessionId: string,
    requestId: string,
    allow: boolean,
    opts?: { reason?: string; optionId?: string },
  ) => Promise<void>;
  setPermissionMode: (sessionId: string, mode: string) => Promise<void>;
  // notify 通知条 (全局, 跨会话展示)
  notifications: UiNotification[];
  dismissNotification: (id: string) => void;
  /** 软件级提示 (如点开的路径不存在): 走同一个右下角弹窗, 3.5s 自动消失 */
  notify: (message: string, notifyType?: UiNotification["notifyType"]) => void;
}

// reattach 防竞态: 每次递增, 异步完成时比对, 不一致则丢弃 (快速连切时旧 reattach 不串到当前会话)
let reattachEpoch = 0;
// detached 会话 entries 常驻上限, 超限清最久未访问 (防长期使用内存无限增长)
const ENTRY_CACHE_LIMIT = 20;
// 自动重试条目的复用槽位 id: pi 一轮里可能连发多次 auto_retry_start, 固定 id 让它们原地刷新成
// 一条「重试中 N/M」而不是刷屏。重试彻底失败转成最终错误时会换成 uuid 脱离此槽位, 见 auto_retry_end
const RETRY_ENTRY_ID = "__auto_retry__";

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
        // Rust 首帧直读: 历史会话 entries 随 start_session 一并返回, 前端直接渲染
        const sessionPath = opts?.sessionPath ?? null;
        const requestedKind = normalizeAgentKind(opts?.agentKind);
        const data = await invoke<{
          sessionId: string;
          agentKind?: AgentKind;
          capabilities?: AgentCapabilities;
          permissionMode?: string | null;
          entries?: unknown[];
        }>("start_session", {
          cwd,
          agentKind: requestedKind,
          provider: opts?.provider ?? null,
          model: opts?.model ?? null,
          permissionMode: opts?.permissionMode ?? null,
          sessionPath,
        });
        const id = data.sessionId;
        const agentKind = normalizeAgentKind(data.agentKind ?? requestedKind);
        const capabilities = data.capabilities ?? PI_CAPABILITIES;
        const permissionMode = data.permissionMode ?? (capabilities.permissionModes[0] ?? null);
        // Array.isArray 守卫直接收窄类型 (布尔中间变量无法把收窄传给后续使用)
        const rawEntries = Array.isArray(data.entries) ? data.entries : null;
        const entries = rawEntries ? mapHistoryEntries(rawEntries) : [];
        set((state) => ({
          sessions: {
            ...state.sessions,
            [id]: {
              sessionId: id, agentKind, capabilities, cwd, sessionPath, sessionName: null,
              isStreaming: false, entries, currentAssistantId: null,
              detached: false, lastEntryMtime: null, hasUnread: false,
              error: null, currentModel: null, thinkingLevel: "medium",
              availableModels: [], availableThinkingLevels: ["off"],
              steeringQueue: [], followUpQueue: [], uiRequests: [],
              permissionRequests: [], permissionMode, remoteSessionId: null,
              contextUsage: null, tokenStats: null, turnStats: null,
            },
          },
          activeSessionId: id,
          sessionOrder: [...state.sessionOrder.filter((sid) => sid !== id), id],
        }));
        const tasks: Promise<unknown>[] = [
          get().loadState(id),
          get().loadSessionStats(id),
        ];
        if (capabilities.hotModelSwitch) tasks.push(get().loadModels(id));
        if (capabilities.thinkingLevel) tasks.push(get().loadThinkingLevels(id));
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
      // 进程停了, 未结算的实时量丢弃 (半截数据留着只会让速度显示失真)
      resetLive(sessionId);
      // detach: 停 pi 进程但保留 entries (秒切缓存); sessionOrder 保留让侧边栏 openId 仍命中快路径
      // uiRequests 同步清空: 进程没了 pi 侧 pending 自动 reject, 前端不能留悬挂弹窗
      patch(sessionId, {
        detached: true,
        isStreaming: false,
        currentAssistantId: null,
        uiRequests: [],
        permissionRequests: [],
      });
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
        // 同步清速度累加器: live Map 在 zustand 之外, 不跟着 prune 清就会随会话淘汰持续涨
        toRemove.forEach((sid) => { dropSession(sid); agentEpoch.delete(sid); });
        const sessionOrder = state.sessionOrder.filter((sid) => !toRemove.includes(sid));
        const activeSessionId = toRemove.includes(state.activeSessionId ?? "")
          ? (sessionOrder[sessionOrder.length - 1] ?? null)
          : state.activeSessionId;
        return { sessions, sessionOrder, activeSessionId };
      });
    },

    // 真删前端 state (不调 invoke): 删会话文件 / 移除项目 / 关新会话节点用, 进程已由 stopSession 停
    removeSessionState: (sessionId) => {
      dropSession(sessionId);   // 同步清速度累加器, 防 Map 泄漏
      agentEpoch.delete(sessionId);
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

    // reattach: detached 会话切回时后台重建子进程, mtime 守卫决定是否重读 entries
    reattachSession: async (sessionId, cwd, sessionPath, agentKind) => {
      const epoch = ++reattachEpoch;
      const kind = normalizeAgentKind(agentKind ?? get().sessions[sessionId]?.agentKind);
      // 复用 start_session 传原 sessionId: Rust 侧 rebind 事件流到原 id, 缓存 entries 不用迁移 key
      try {
        await invoke("start_session", {
          cwd, agentKind: kind, provider: null, model: null, sessionPath, sessionId,
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
      resetLive(sessionId);
      patch(sessionId, {
        detached: true,
        isStreaming: false,
        currentAssistantId: null,
        uiRequests: [],
        permissionRequests: [],
      });
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
      // 乐观置位保「发出即等待提示」, 但只有真跑 agent 才该一直亮着: 扩展命令 (如 /purge) 的
      // disposition 是 handled —— pi 不跑 agent 也就不发 agent_settled, 这条运行中没人会收
      const epoch = epochOf(sessionId);
      patch(sessionId, {
        entries: [...s.entries, { id: crypto.randomUUID(), kind: "message", role: "user", text }],
        isStreaming: true,
      });
      try {
        const data = await invoke<{ disposition?: string } | null>("send_prompt", {
          sessionId, message: text, images: images ?? null,
        });
        // handled = pi 侧被扩展命令 / input handler 消化, 没有 agent 在跑。
        // 纪元没推进说明这期间没发过 agent_start, 界面上那个运行中就是乐观置位的残影, 收回
        if (data?.disposition === "handled" && epochOf(sessionId) === epoch) {
          patch(sessionId, { isStreaming: false, currentAssistantId: null });
        }
      } catch (e) {
        // 失败不能盲目收回运行中: 扩展命令的 handler 可能已经把 agent 跑起来了 (RPC 超时就属于这种),
        // 纪元推进过就说明 agent_start 已到, 状态交给事件流, 这里只报错
        patch(sessionId, epochOf(sessionId) === epoch
          ? { isStreaming: false, error: String(e) }
          : { error: String(e) });
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
      // abort 的 response 要等 pi 侧会话变 idle 才回, 回来说明已经没 agent 在跑了。
      // 事件流正常时由 agent_settled 收尾, 这里只兜异常路径 —— 否则误置的「运行中」
      // 没有任何东西能把它关掉 (空闲时 abort 不产生任何事件)。纪元推进 = 期间又起了新一轮, 不动
      const epoch = epochOf(sessionId);
      try {
        await invoke("abort_session", { sessionId });
        if (epochOf(sessionId) === epoch) {
          patch(sessionId, { isStreaming: false, currentAssistantId: null });
        }
      } catch (e) {
        patch(sessionId, { error: String(e) });
      }
    },

    loadState: async (sessionId) => {
      try {
        const data = await invoke<Record<string, unknown>>("get_state", { sessionId });
        const cur = get().sessions[sessionId];
        patch(sessionId, {
          currentModel: (data.model as ModelInfo) || cur?.currentModel || null,
          thinkingLevel: (data.thinkingLevel as string) || cur?.thinkingLevel || "medium",
          permissionMode: (data.permissionMode as string) || cur?.permissionMode || null,
          remoteSessionId: (data.remoteSessionId as string) || cur?.remoteSessionId || null,
          // 新会话 spawn 后 get_state 即返回真实 sessionFile 路径 (文件在首次 prompt 后才落盘);
          // 有值才覆盖, 无值 (极端情况) 保留 startSession 传入的历史路径
          sessionPath: (data.sessionFile as string) || (cur?.sessionPath ?? null),
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
      // 扩展 notify 允许在无源 session 时走右下角兜底弹窗; 其余事件无对应 session 直接丢弃
      if (!s && !(event.type === "notice" && event.fromExtension)) return;
      switch (event.type) {
        case "turn_start": {
          // 纪元推进: prompt 的 disposition / abort 的 response 回来时靠它判断期间起没起过 agent
          agentEpoch.set(sessionId, epochOf(sessionId) + 1);
          // 只在上一轮已定格 (或从未跑过) 时重置统计: 自动重试会在同一轮里再次发 turn_start
          const prev = s!.turnStats;
          const fresh = !prev || prev.elapsedMs !== null;
          if (fresh) startRound(sessionId);
          patch(sessionId, {
            isStreaming: true,
            turnStats: fresh
              ? { input: 0, output: 0, cost: 0, liveInput: 0, liveOutput: 0, startedAt: Date.now(), elapsedMs: null,
                  genStartedAt: null, deltaCounts: { thinking: 0, text: 0, toolcall: 0 }, speed: null, calls: [],
                  lastCache: null, cacheSeen: false }
              : prev,
          });
          break;
        }
        case "assistant_start": {
          const id = event.messageId || crypto.randomUUID();
          const cur = get().sessions[sessionId]!;
          patch(sessionId, {
            entries: [...cur.entries, { id, kind: "message", role: "assistant", text: "", thinking: "" }],
            currentAssistantId: id,
          });
          break;
        }
        case "live_usage": {
          const cur = get().sessions[sessionId];
          if (cur?.turnStats && (event.input > 0 || event.output > 0)) {
            patch(sessionId, {
              turnStats: { ...cur.turnStats, liveInput: event.input, liveOutput: event.output },
            });
          }
          break;
        }
        case "content_block_start": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          const drafting = event.block === "tool_call";
          const target = cur.currentAssistantId
            ? cur.entries.find((e) => e.id === cur.currentAssistantId && e.kind === "message")
            : undefined;
          if (target && !!target.draftingTool !== drafting) {
            patch(sessionId, { entries: cur.entries.map((e) => (e === target ? { ...e, draftingTool: drafting } : e)) });
          }
          break;
        }
        case "text_delta": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          noteDelta(sessionId, "text_delta", event.delta.length > 0, Date.now());
          if (!cur.currentAssistantId || !event.delta) break;
          patch(sessionId, {
            entries: cur.entries.map((e) =>
              e.id === cur.currentAssistantId && e.kind === "message" ? { ...e, text: (e.text || "") + event.delta } : e
            ),
          });
          break;
        }
        case "thinking_delta": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          noteDelta(sessionId, "thinking_delta", event.delta.length > 0, Date.now());
          if (!cur.currentAssistantId || !event.delta) break;
          patch(sessionId, {
            entries: cur.entries.map((e) =>
              e.id === cur.currentAssistantId && e.kind === "message" ? { ...e, thinking: (e.thinking || "") + event.delta } : e
            ),
          });
          break;
        }
        case "tool_call_delta": {
          // 零 React 重渲染: 仅写入模块级累加器用于实时输出速度估算
          noteDelta(sessionId, "toolcall_delta", event.hasDelta, Date.now());
          break;
        }
        case "assistant_end": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          const fields: Partial<SessionState> = { currentAssistantId: null };
          const u = event.usage;
          const settledSpeed = settle(sessionId, u?.output ?? 0, Date.now());
          if (cur.turnStats && u) {
            fields.turnStats = {
              ...cur.turnStats,
              input: cur.turnStats.input + u.input,
              output: cur.turnStats.output + u.output,
              cost: cur.turnStats.cost + (u.cost ?? 0),
              lastCache: {
                input: u.input,
                cacheRead: u.cacheRead,
                cacheWrite: u.cacheWrite,
              },
              cacheSeen: cur.turnStats.cacheSeen || u.cacheRead > 0 || u.cacheWrite > 0,
              liveInput: 0,
              liveOutput: 0,
              genStartedAt: null,
              deltaCounts: settledSpeed?.counts ?? cur.turnStats.deltaCounts,
              calls: settledSpeed?.calls ?? cur.turnStats.calls,
              speed: settledSpeed?.speed ?? cur.turnStats.speed,
            };
          } else if (cur.turnStats && settledSpeed) {
            fields.turnStats = {
              ...cur.turnStats,
              genStartedAt: null,
              deltaCounts: settledSpeed.counts,
            };
          }
          if (event.stopReason === "error") {
            fields.entries = [...cur.entries, {
              id: crypto.randomUUID(), kind: "notification", notifyType: "error",
              text: `模型返回错误: ${event.errorMessage || "无详细信息"}`,
            }];
          }
          patch(sessionId, fields);
          break;
        }
        case "tool_start": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          patch(sessionId, { entries: [...cur.entries, {
            id: event.toolCallId, kind: "tool", toolCallId: event.toolCallId,
            toolName: event.toolName, args: event.args, status: "running",
            startedAt: Date.now(),
          }]});
          break;
        }
        case "tool_end": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          patch(sessionId, { entries: cur.entries.map((e) =>
            e.kind === "tool" && e.toolCallId === event.toolCallId
              ? { ...e, status: event.isError ? "error" : "done", result: event.result, endedAt: Date.now() } : e
          )});
          break;
        }
        case "tool_update": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          const idx = cur.entries.findIndex((e) => e.kind === "tool" && e.toolCallId === event.toolCallId);
          if (idx < 0) break;
          patch(sessionId, {
            entries: cur.entries.map((e, i) => (i === idx ? { ...e, result: event.partialResult } : e)),
          });
          break;
        }
        case "retry_start": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          const text = `模型调用失败, 重试中 (${event.attempt}/${event.maxAttempts}): ${event.errorMessage || "未知错误"}`;
          const entry: ChatEntry = { id: RETRY_ENTRY_ID, kind: "notification", notifyType: "warning", text };
          const exists = cur.entries.some((e) => e.id === RETRY_ENTRY_ID);
          patch(sessionId, {
            entries: exists
              ? cur.entries.map((e) => (e.id === RETRY_ENTRY_ID ? entry : e))
              : [...cur.entries, entry],
          });
          break;
        }
        case "retry_end": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          if (event.success) {
            patch(sessionId, { entries: cur.entries.filter((e) => e.id !== RETRY_ENTRY_ID) });
          } else {
            const text = `模型调用失败, 已重试 ${event.attempt} 次仍未成功: ${event.finalError || "无详细信息"}`;
            patch(sessionId, {
              entries: cur.entries.map((e) =>
                e.id === RETRY_ENTRY_ID
                  ? { id: crypto.randomUUID(), kind: "notification" as const, notifyType: "error" as const, text }
                  : e
              ),
            });
          }
          break;
        }
        case "queue_update": {
          patch(sessionId, { steeringQueue: event.steering || [], followUpQueue: event.followUp || [] });
          break;
        }
        case "turn_settled": {
          const cur = get().sessions[sessionId];
          const settled: Partial<SessionState> = { isStreaming: false, currentAssistantId: null };
          if (cur?.turnStats?.startedAt) {
            const fin = finishRound(sessionId);
            settled.turnStats = {
              ...cur.turnStats,
              liveInput: 0, liveOutput: 0,
              genStartedAt: null,
              elapsedMs: Date.now() - cur.turnStats.startedAt,
              ...(fin ? { calls: fin.calls, speed: fin.speed } : {}),
            };
          }
          if (cur?.entries.some((e) => e.id === RETRY_ENTRY_ID)) {
            settled.entries = cur.entries.filter((e) => e.id !== RETRY_ENTRY_ID);
          }
          patch(sessionId, settled);
          get().loadSessionStats(sessionId);
          if (get().activeSessionId !== sessionId) {
            patch(sessionId, { hasUnread: true });
          }
          {
            const sp = get().sessions[sessionId]?.sessionPath;
            const inDisk = useProjectsStore.getState().projects.some((p) =>
              p.sessions.some((ds) => pathEq(ds.session_path, sp))
            );
            if (sp && !inDisk) {
              useProjectsStore.getState().loadProjects();
            }
          }
          {
            const c = get().sessions[sessionId]?.cwd;
            if (c) useGitStore.getState().loadStatus(c);
          }
          break;
        }
        case "process_exit": {
          patch(sessionId, {
            isStreaming: false,
            currentAssistantId: null,
            uiRequests: [],
            permissionRequests: [],
            error: event.message || "Agent 进程已退出",
          });
          break;
        }
        case "ui_request": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          patch(sessionId, { uiRequests: [...cur.uiRequests, event.request] });
          break;
        }
        case "permission_request": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          patch(sessionId, { permissionRequests: [...cur.permissionRequests, event.request] });
          break;
        }
        case "session_meta": {
          const cur = get().sessions[sessionId];
          if (!cur) break;
          const fields: Partial<SessionState> = {};
          if (event.sessionPath) fields.sessionPath = event.sessionPath;
          if (event.remoteSessionId) fields.remoteSessionId = event.remoteSessionId;
          if (event.permissionMode) fields.permissionMode = event.permissionMode;
          if (event.model) {
            fields.currentModel = {
              id: event.model,
              name: event.model,
              provider: cur.agentKind === "claude" ? "anthropic" : cur.agentKind,
            };
          }
          patch(sessionId, fields);
          break;
        }
        case "notice": {
          const raw = event.message || "";
          const notifyType = event.notifyType || "info";
          if (event.fromExtension) {
            // 扩展面向 TUI 的带 ANSI/NerdFont 装饰 info 条丢弃, warning/error 剥干净照显
            const terminalOnly = hasTerminalMarkup(raw);
            if (terminalOnly && notifyType === "info") break;
            const text = terminalOnly ? stripTerminalMarkup(raw) : raw;
            if (!text) break;
            const id = event.id || crypto.randomUUID();
            if (s) {
              patch(sessionId, {
                entries: [...s.entries, { id, kind: "notification", notifyType, text }],
              });
            } else {
              set((state) => ({ notifications: [...state.notifications, { id, message: text, notifyType }] }));
            }
          } else {
            if (!s || !raw) break;
            patch(sessionId, {
              entries: [...s.entries, { id: event.id || crypto.randomUUID(), kind: "notification", notifyType, text: raw }],
            });
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

    respondPermission: async (sessionId, requestId, allow, opts) => {
      const cur = get().sessions[sessionId];
      if (cur) {
        patch(sessionId, {
          permissionRequests: cur.permissionRequests.filter((r) => r.id !== requestId),
        });
      }
      try {
        await invoke("respond_permission", {
          sessionId,
          requestId,
          allow,
          reason: opts?.reason ?? null,
          optionId: opts?.optionId ?? null,
        });
      } catch (e) {
        patch(sessionId, { error: `发送权限审批响应失败: ${String(e)}` });
      }
    },

    setPermissionMode: async (sessionId, mode) => {
      try {
        await invoke("set_permission_mode", { sessionId, mode });
        patch(sessionId, { permissionMode: mode });
      } catch (e) {
        patch(sessionId, { error: `切换权限模式失败: ${String(e)}` });
      }
    },

    dismissNotification: (id) => {
      set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) }));
    },

    notify: (message, notifyType = "warning") => {
      const n: UiNotification = { id: crypto.randomUUID(), message, notifyType };
      set((state) => ({ notifications: [...state.notifications, n] }));
    },

    // 速度采样: 实时累加器不在 store 里 (高频写入刻意不走 zustand, 避免每 token 一次重渲染),
    // 由 InputBar 的 tick 主动拉取。轮次已结束时累加器已空, 返回 null 让界面读 store 的定格值
    sampleSpeed: (sessionId) => liveSpeedFor(sessionId, Date.now()),
  };
});

// ISO 时间戳 → epoch ms, 无效/缺失 → undefined (舰队 stream 耗时计算用, 无值显示 —)
function parseTs(ts?: string): number | undefined {
  if (!ts) return undefined;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * get_entries 历史条目 → ChatEntry 映射 (纯函数, 便于测试)
 * message 条目: user 取 text 块拼接; assistant 拆 thinking/text/toolCall 块
 * 其余类型 (model_change 等) 忽略
 */
export function mapHistoryEntries(entries: unknown[]): ChatEntry[] {
  const result: ChatEntry[] = [];
  for (const raw of entries) {
    const e = raw as {
      id?: string;
      type?: string;
      timestamp?: string;
      message?: {
        role?: string;
        content?: unknown[];
        // toolResult 专有: 按 toolCallId 回填, details 含 diff/patch, isError 还原 status
        toolCallId?: string;
        details?: unknown;
        isError?: boolean;
      };
    };
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
          // 先以占位入列 (result:null): jsonl 里 toolResult 是与 user/assistant 平级的独立行,
          // 后续循环按 toolCallId 回填完整 result (含 details) 与 status
          result.push({
            id: b.id ?? crypto.randomUUID(), kind: "tool",
            toolCallId: b.id, toolName: b.name, args: b.arguments,
            status: "done", result: null,
            startedAt: parseTs(e.timestamp),
          });
        }
      }
      if (text || thinking) {
        result.push({
          id: e.id ?? crypto.randomUUID(), kind: "message", role: "assistant",
          text, thinking: thinking || undefined,
        });
      }
    } else if (e.message.role === "toolResult") {
      // pi session jsonl 里 toolResult 是独立行 (与 user/assistant 平级), 早期回放只判
      // user/assistant 导致它落空、工具结果写死 null。这里按 toolCallId 回填到已产生的 tool entry:
      // toolCall 一定先于 toolResult (jsonl 时序), 单趟遍历即可命中, 不需要两趟扫描
      const msg = e.message;
      const toolCallId = msg.toolCallId;
      if (!toolCallId) continue;
      const idx = result.findIndex((en) => en.kind === "tool" && en.toolCallId === toolCallId);
      // 孤儿 toolResult (历史被压缩截断等): 丢弃, 不报错、不造空卡片
      if (idx < 0) continue;
      // 回填形状对齐实时路径 (tool_execution_end): result = {content, details} 整体保留,
      // status 由 isError 还原 —— 同一个 ToolCallCard 不因来源不同走两套渲染
      result[idx] = {
        ...result[idx],
        status: msg.isError ? "error" : "done",
        result: { content: msg.content, details: msg.details },
        endedAt: parseTs(e.timestamp),
      };
    }
  }
  return result;
}