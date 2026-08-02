import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// 对话流里的条目: 消息 或 工具调用, 按时间顺序排列
export interface ChatEntry {
  id: string;
  kind: "message" | "tool";
  // message 字段
  role?: "user" | "assistant";
  text?: string;
  // tool 字段
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  status?: "running" | "done" | "error";
  result?: unknown;
}

interface SessionStore {
  sessionId: string | null;
  cwd: string;
  isStreaming: boolean;
  entries: ChatEntry[];
  // 当前正在流式输出的 assistant 消息 id, 用于 text_delta 追加
  currentAssistantId: string | null;
  error: string | null;

  startSession: (cwd: string, provider?: string, model?: string) => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  stopSession: () => Promise<void>;
  handleEvent: (event: Record<string, unknown>) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessionId: null,
  cwd: "",
  isStreaming: false,
  entries: [],
  currentAssistantId: null,
  error: null,

  startSession: async (cwd, provider, model) => {
    const id = await invoke<string>("start_session", { cwd, provider, model });
    set({ sessionId: id, cwd, entries: [], isStreaming: false, error: null });
  },

  sendPrompt: async (text) => {
    const { sessionId, entries } = get();
    if (!sessionId || !text.trim()) return;
    // 先把用户消息加进列表, 这样界面立刻有反馈
    set({
      entries: [
        ...entries,
        { id: crypto.randomUUID(), kind: "message", role: "user", text },
      ],
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

  // 核心: 把 pi 的流式事件映射成 GUI 状态更新
  // M1 只处理 text_delta 流式文字 + 工具调用卡片, thinking 等留到 M2
  handleEvent: (event) => {
    const type = event.type as string;
    switch (type) {
      case "agent_start":
        set({ isStreaming: true });
        break;

      // assistant 消息开始: 追加一条空 assistant 消息, 记下 id 供 text_delta 追加
      case "message_start": {
        const msg = event.message as { role?: string; id?: string } | undefined;
        if (msg?.role === "assistant") {
          const id = msg.id || crypto.randomUUID();
          set((state) => ({
            entries: [
              ...state.entries,
              { id, kind: "message", role: "assistant", text: "" },
            ],
            currentAssistantId: id,
          }));
        }
        break;
      }

      // 流式 delta: M1 只处理 text_delta (逐字拼接), 其余 delta 类型留到 M2
      case "message_update": {
        const ev = event.assistantMessageEvent as
          | { type?: string; delta?: string }
          | undefined;
        if (ev?.type === "text_delta" && ev.delta) {
          const { currentAssistantId, entries } = get();
          if (currentAssistantId) {
            set({
              entries: entries.map((e) =>
                e.id === currentAssistantId && e.kind === "message"
                  ? { ...e, text: (e.text || "") + ev.delta }
                  : e
              ),
            });
          }
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
              ? {
                  ...e,
                  status: event.isError ? "error" : "done",
                  result: event.result,
                }
              : e
          ),
        }));
        break;

      // agent 完全停止: 解锁输入框
      case "agent_settled":
        set({ isStreaming: false, currentAssistantId: null });
        break;

      case "pi_process_exit":
        set({ isStreaming: false, currentAssistantId: null, error: "pi 进程已退出" });
        break;
    }
  },
}));