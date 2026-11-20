// 多 Agent 后端统一前端契约 (与 Rust `src-tauri/src/backends/mod.rs` 一一对应)
import type { UiNotification, UiRequest } from "./pi";

export type AgentKind = "pi" | "claude" | "agy";

export interface AgentCapabilities {
  steer: boolean;
  followUp: boolean;
  hotModelSwitch: boolean;
  thinkingLevel: boolean;
  permissionModes: string[];
  extensionUi: boolean;
  toolApproval: boolean;
  remoteCommands: boolean;
  sessionRename: boolean;
  fleetView: boolean;
  modelsEditor: boolean;
}

export interface AgentDescriptor {
  kind: AgentKind;
  label: string;
  badge: string;
  installed: boolean;
  version: string | null;
  implemented: boolean;
  available: boolean;
  reason: string | null;
  capabilities: AgentCapabilities;
}

export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
}

export type ContentBlockKind = "text" | "thinking" | "tool_call";

export type UnifiedEvent =
  | { type: "turn_start" }
  | { type: "assistant_start"; messageId: string | null }
  | { type: "content_block_start"; block: ContentBlockKind }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_delta"; hasDelta: boolean }
  | { type: "live_usage"; input: number; output: number }
  | {
      type: "assistant_end";
      usage: MessageUsage | null;
      stopReason: string | null;
      errorMessage: string | null;
    }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; isError: boolean; result: unknown }
  | { type: "retry_start"; attempt: number; maxAttempts: number; errorMessage: string | null }
  | { type: "retry_end"; success: boolean; attempt: number; finalError: string | null }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "ui_request"; request: UiRequest }
  | {
      type: "notice";
      id: string | null;
      notifyType: UiNotification["notifyType"];
      message: string;
      fromExtension: boolean;
    }
  | { type: "turn_settled" }
  | { type: "process_exit"; agentKind: AgentKind; message: string };

export interface AgentEventPayload {
  sessionId: string;
  event: UnifiedEvent;
}

/** 各 Agent 的静态展示元数据 (侧栏徽标 / 过滤胶囊 / 回退展示共用) */
export const AGENT_META: Record<AgentKind, { label: string; badge: string }> = {
  pi: { label: "Pi", badge: "PI" },
  claude: { label: "Claude Code", badge: "CC" },
  agy: { label: "Antigravity", badge: "AGY" },
};

export const AGENT_KINDS: AgentKind[] = ["pi", "claude", "agy"];

export const PI_CAPABILITIES: AgentCapabilities = {
  steer: true,
  followUp: true,
  hotModelSwitch: true,
  thinkingLevel: true,
  permissionModes: [],
  extensionUi: true,
  toolApproval: false,
  remoteCommands: true,
  sessionRename: true,
  fleetView: true,
  modelsEditor: true,
};

export function normalizeAgentKind(kind?: string | null): AgentKind {
  if (kind === "claude" || kind === "agy" || kind === "pi") return kind;
  return "pi";
}
