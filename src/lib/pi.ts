// pi RPC 事件类型定义 (前端侧, 与 Rust 侧 serde_json::Value 对应)
// M1 只用到部分事件和字段, 完整类型留到后续补全

export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiEventPayload {
  sessionId: string;
  event: PiEvent;
}

/** pi AgentMessage (简化, 完整结构见 pi 文档) */
export interface PiMessage {
  id?: string;
  role: "user" | "assistant" | "system";
  content?: unknown[];
}

/** message_update 里的 delta 事件 */
export interface AssistantMessageEvent {
  type:
    | "start"
    | "text_start"
    | "text_delta"
    | "text_end"
    | "thinking_start"
    | "thinking_delta"
    | "thinking_end"
    | "toolcall_start"
    | "toolcall_delta"
    | "toolcall_end"
    | "done"
    | "error";
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: unknown;
  toolCall?: unknown;
  reason?: string;
}