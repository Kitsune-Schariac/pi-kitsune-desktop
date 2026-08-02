import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// 对话流里的条目: 消息 或 工具调用, 按时间顺序排列
export interface ChatEntry {
  id: string;
  kind: "message" | "tool";
  // message 字段
  role?: "user" | "assistant";
  text?: string;
  thinking?: string; // M2: 推理过程, 和正文分开渲染 (折叠面板)
  // tool 字段
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  status?: "running" | "done" | "error";
  result?: unknown;
}

// M2: 模型信息 (从 pi get_available_models / get_state 返回里提取)
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface SessionStore {
  // M1: 会话与对话
  sessionId: string | null;
  cwd: string;
  isStreaming: boolean;
  entries: ChatEntry[];
  currentAssistantId: string | null;
  error: string | null;

  // M2: 模型与思考级别
  currentModel: ModelInfo | null;
  thinkingLevel: string;
  availableModels: ModelInfo[];
  availableThinkingLevels: string[];

  // M2: steer/followUp 待处理队列
  steeringQueue: string[];
  followUpQueue: string[];

  // M1 actions
  startSession: (cwd: string, provider?: string, model?: string) => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  stopSession: () => Promise<void>;
  handleEvent: (event: Record<string, unknown>) => void;

  // M2 actions
  loadState: () => Promise<void>;
  loadModels: () => Promise<void>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  cycleModel: () => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  cycleThinkingLevel: () => Promise<void>;
  loadThinkingLevels: () => Promise<void>;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessionId: null,
  cwd: "",
  isStreaming: false,
  entries: [],
  currentAssistantId: null,
  error: null,
  currentModel: null,
  thinkingLevel: "medium",
  availableModels: [],
  availableThinkingLevels: ["off"],
  steeringQueue: [],
  followUpQueue: [],

  startSession: async (cwd, provider, model) => {
    const id = await invoke<string>("start_session", { cwd, provider, model });
    set({ sessionId: id, cwd, entries: [], isStreaming: false, error: null });
    // M2: 连接成功后拉取模型状态 + 列表 + 思考级别
    await Promise.all([get().loadState(), get().loadModels(), get().loadThinkingLevels()]);
  },

  sendPrompt: async (text) => {
    const { sessionId, entries } = get();
    if (!sessionId || !text.trim()) return;
    set({
      entries: [...entries, { id: crypto.randomUUID(), kind: "message", role: "user", text }],
      isStreaming: true,
    });
    try {
      await invoke("send_prompt", { message: text });
    } catch (e) {
      set({ isStreaming: false, error: String(e) });
    }
  },

  abort: async () => {
    try {
      await invoke("abort_session");
    } catch (e) {
      set({ error: String(e) });
    }
  },

  stopSession: async () => {
    try {
      await invoke("stop_session");
    } catch {
      // 忽略: 进程可能已退出
    }
    set({ sessionId: null, entries: [], isStreaming: false, currentAssistantId: null });
  },

  // 核心: 把 pi 流式事件映射成 GUI 状态更新
  handleEvent: (event) => {
    const type = event.type as string;
    switch (type) {
      case "agent_start":
        set({ isStreaming: true });
        break;

      // assistant 消息开始: 追加一条空 assistant 消息, 记下 id 供后续 delta 追加
      case "message_start": {
        const msg = event.message as { role?: string; id?: string } | undefined;
        if (msg?.role === "assistant") {
          const id = msg.id || crypto.randomUUID();
          set((state) => ({
            entries: [...state.entries, { id, kind: "message", role: "assistant", text: "", thinking: "" }],
            currentAssistantId: id,
          }));
        }
        break;
      }

      // 流式 delta: text_delta 追加正文, thinking_delta 追加推理 (M2 新增)
      case "message_update": {
        const ev = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        const { currentAssistantId, entries } = get();
        if (!currentAssistantId || !ev?.delta) break;
        if (ev.type === "text_delta") {
          set({
            entries: entries.map((e) =>
              e.id === currentAssistantId && e.kind === "message"
                ? { ...e, text: (e.text || "") + ev.delta! }
                : e
            ),
          });
        } else if (ev.type === "thinking_delta") {
          set({
            entries: entries.map((e) =>
              e.id === currentAssistantId && e.kind === "message"
                ? { ...e, thinking: (e.thinking || "") + ev.delta! }
                : e
            ),
          });
        }
        break;
      }

      case "message_end":
        set({ currentAssistantId: null });
        break;

      case "tool_execution_start": {
        const entry: ChatEntry = {
          id: event.toolCallId as string,
          kind: "tool",
          toolCallId: event.toolCallId as string,
          toolName: event.toolName as string,
          args: event.args,
          status: "running",
        };
        set((state) => ({ entries: [...state.entries, entry] }));
        break;
      }

      case "tool_execution_end":
        set((state) => ({
          entries: state.entries.map((e) =>
            e.kind === "tool" && e.toolCallId === event.toolCallId
              ? { ...e, status: event.isError ? "error" : "done", result: event.result }
              : e
          ),
        }));
        break;

      // M2: steer/followUp 队列变化
      case "queue_update": {
        const q = event as { steering?: string[]; followUp?: string[] };
        set({ steeringQueue: q.steering || [], followUpQueue: q.followUp || [] });
        break;
      }

      case "agent_settled":
        set({ isStreaming: false, currentAssistantId: null });
        break;

      case "pi_process_exit":
        set({ isStreaming: false, currentAssistantId: null, error: "pi 进程已退出" });
        break;
    }
  },

  // M2 actions: 模型与思考级别控制
  loadState: async () => {
    try {
      const data = await invoke<Record<string, unknown>>("get_state");
      const model = data.model as ModelInfo | null | undefined;
      set({ currentModel: model || null, thinkingLevel: (data.thinkingLevel as string) || "medium" });
    } catch { /* 忽略 */ }
  },

  loadModels: async () => {
    try {
      const data = await invoke<{ models: ModelInfo[] }>("get_available_models");
      set({ availableModels: data.models || [] });
    } catch { /* 忽略 */ }
    },

  setModel: async (provider, modelId) => {
    try {
      const data = await invoke<ModelInfo>("set_model", { provider, model_id: modelId });
      set({ currentModel: data });
    } catch (e) { set({ error: String(e) }); }
  },

  cycleModel: async () => {
    try {
      const data = await invoke<{ model: ModelInfo; thinkingLevel: string } | null>("cycle_model");
      if (data?.model) set({ currentModel: data.model, thinkingLevel: data.thinkingLevel || get().thinkingLevel });
    } catch { /* 忽略 */ }
  },

  setThinkingLevel: async (level) => {
    try {
      await invoke("set_thinking_level", { level });
      set({ thinkingLevel: level });
    } catch (e) { set({ error: String(e) }); }
  },

  cycleThinkingLevel: async () => {
    try {
      const data = await invoke<{ level: string } | null>("cycle_thinking_level");
      if (data?.level) set({ thinkingLevel: data.level });
    } catch { /* 忽略 */ }
  },

  loadThinkingLevels: async () => {
    try {
      const data = await invoke<{ levels: string[] }>("get_available_thinking_levels");
      set({ availableThinkingLevels: data.levels || ["off"] });
    } catch { /* 忽略 */ }
  },
}));