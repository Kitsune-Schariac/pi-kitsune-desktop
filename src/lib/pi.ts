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

/** extension_ui_request 请求 (pi 扩展 UI 子协议, 见 rpc.md Extension UI Protocol) */
export interface UiRequest {
  id: string;
  method: "confirm" | "select" | "input" | "editor" | "notify" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  timeout?: number;
}

/** notify 通知条 (fire-and-forget, 无需响应) */
export interface UiNotification {
  id: string;
  message: string;
  notifyType: "info" | "warning" | "error";
}