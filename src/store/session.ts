import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

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
interface SessionState {
  sessionId: string;
  cwd: string;
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
}

interface SessionStore {
  sessions: Record<string, SessionState>;
  activeSessionId: string | null;
  sessionOrder: string[];

  startSession: (cwd: string, provider?: string, model?: string) => Promise<string>;
  stopSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string) => void;
  sendPrompt: (sessionId: string, text: string) => Promise<void>;
  abort: (sessionId: string) => Promise<void>;
  setModel: (sessionId: string, provider: string, modelId: string) => Promise<void>;
  cycleModel: (sessionId: string) => Promise<void>;
  setThinkingLevel: (sessionId: string, level: string) => Promise<void>;
  cycleThinkingLevel: (sessionId: string) => Promise<void>;
  loadState: (sessionId: string) => Promise<void>;
  loadModels: (sessionId: string) => Promise<void>;
  loadThinkingLevels: (sessionId: string) => Promise<void>;
  handleEvent: (payload: { sessionId: string; event: Record<string, unknown> }) => void;
}

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

    startSession: async (cwd, provider, model) => {
      const id = await invoke<string>("start_session", { cwd, provider, model });
      set((state) => ({
        sessions: {
          ...state.sessions,
          [id]: {
            sessionId: id, cwd, isStreaming: false, entries: [], currentAssistantId: null,
            error: null, currentModel: null, thinkingLevel: "medium",
            availableModels: [], availableThinkingLevels: ["off"],
            steeringQueue: [], followUpQueue: [],
          },
        },
        activeSessionId: id,
        sessionOrder: [...state.sessionOrder.filter((sid) => sid !== id), id],
      }));
      await Promise.all([get().loadState(id), get().loadModels(id), get().loadThinkingLevels(id)]);
      return id;
    },

    stopSession: async (sessionId) => {
      try { await invoke("stop_session", { sessionId }); } catch { /* ignore */ }
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

    setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

    sendPrompt: async (sessionId, text) => {
      const s = get().sessions[sessionId];
      if (!s || !text.trim()) return;
      patch(sessionId, {
        entries: [...s.entries, { id: crypto.randomUUID(), kind: "message", role: "user", text }],
        isStreaming: true,
      });
      try {
        await invoke("send_prompt", { sessionId, message: text });
      } catch (e) {
        patch(sessionId, { isStreaming: false, error: String(e) });
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
          break;
        case "pi_process_exit":
          patch(sessionId, { isStreaming: false, currentAssistantId: null, error: "pi 进程已退出" });
          break;
      }
    },
  };
});