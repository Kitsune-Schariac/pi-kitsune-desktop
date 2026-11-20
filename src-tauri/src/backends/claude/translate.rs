//! Claude Code `stream-json` 输出帧 → `UnifiedEvent` 状态机翻译器。
//!
//! Claude CLI (`--output-format stream-json --include-partial-messages --verbose`) 会交替输出:
//! - `system` (init): 携带 `session_id` / `model` / `permissionMode`
//! - `stream_event`: 包装 Anthropic Messages API 流式块 (`message_start` / `content_block_*` / `message_delta`)
//! - `assistant`: 完整消息或块快照 (包含已拼完的 `tool_use.input` 及权威 `usage`)
//! - `user`: 工具执行结果 (`content[]` 中的 `tool_result`)
//! - `result`: 整轮结束 (含 `total_cost_usd` / `usage` / `is_error`)
//! - `control_request` (`can_use_tool`): 需宿主审批的工具权限请求

use crate::backends::{
    ContentBlockKind, MessageUsage, NotifyLevel, PermissionOption, PermissionRequestPayload,
    UnifiedEvent,
};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Default)]
pub struct ClaudeStreamTranslator {
    in_turn: bool,
    streamed_current_msg: bool,
    current_msg_id: Option<String>,
    seen_tool_ids: HashSet<String>,
    settled_msg_ids: HashSet<String>,
    /// 本轮内是否已由 assistant_end 结算过 usage (防止 result 重复加倍)
    turn_had_usage: bool,
}

impl ClaudeStreamTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn translate(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let Some(ev_type) = frame.get("type").and_then(|v| v.as_str()) else {
            return Vec::new();
        };

        match ev_type {
            "system" => self.handle_system(frame),
            "stream_event" => self.handle_stream_event(frame),
            "assistant" => self.handle_assistant(frame),
            "user" => self.handle_user(frame),
            "result" => self.handle_result(frame),
            "control_request" => self.handle_control_request(frame),
            _ => Vec::new(),
        }
    }

    fn ensure_turn_started(&mut self, out: &mut Vec<UnifiedEvent>) {
        if !self.in_turn {
            self.in_turn = true;
            self.turn_had_usage = false;
            out.push(UnifiedEvent::TurnStart);
        }
    }

    fn handle_system(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let subtype = frame.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
        if subtype != "init" {
            return Vec::new();
        }
        let session_id = frame
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let model = frame
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let permission_mode = frame
            .get("permissionMode")
            .or_else(|| frame.get("permission_mode"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        vec![UnifiedEvent::SessionMeta {
            session_path: None,
            remote_session_id: session_id,
            model,
            permission_mode,
        }]
    }

    fn handle_stream_event(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let Some(ev) = frame.get("event") else {
            return Vec::new();
        };
        let Some(sub) = ev.get("type").and_then(|v| v.as_str()) else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(2);

        match sub {
            "message_start" => {
                self.ensure_turn_started(&mut out);
                let msg = ev.get("message");
                let message_id = msg
                    .and_then(|m| m.get("id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                self.current_msg_id = message_id.clone();
                self.streamed_current_msg = true;
                out.push(UnifiedEvent::AssistantStart { message_id });
                if let Some(u) = msg.and_then(|m| m.get("usage")) {
                    let input = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let output = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    if input > 0 || output > 0 {
                        out.push(UnifiedEvent::LiveUsage { input, output });
                    }
                }
            }
            "content_block_start" => {
                self.ensure_turn_started(&mut out);
                let bt = ev
                    .get("content_block")
                    .and_then(|b| b.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match bt {
                    "text" => out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Text,
                    }),
                    "thinking" => out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Thinking,
                    }),
                    "tool_use" => out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::ToolCall,
                    }),
                    _ => {}
                }
            }
            "content_block_delta" => {
                self.ensure_turn_started(&mut out);
                let Some(delta) = ev.get("delta") else {
                    return out;
                };
                let dt = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match dt {
                    "text_delta" => {
                        let s = delta.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        out.push(UnifiedEvent::TextDelta {
                            delta: s.to_string(),
                        });
                    }
                    "thinking_delta" => {
                        let s = delta
                            .get("thinking")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        out.push(UnifiedEvent::ThinkingDelta {
                            delta: s.to_string(),
                        });
                    }
                    "input_json_delta" => {
                        let s = delta
                            .get("partial_json")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        out.push(UnifiedEvent::ToolCallDelta {
                            has_delta: !s.is_empty(),
                        });
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(u) = ev.get("usage") {
                    let input = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let output = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    if input > 0 || output > 0 {
                        out.push(UnifiedEvent::LiveUsage { input, output });
                    }
                }
            }
            _ => {}
        }
        out
    }

    fn handle_assistant(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let Some(msg) = frame.get("message") else {
            return Vec::new();
        };
        let mut out = Vec::new();
        self.ensure_turn_started(&mut out);

        let msg_id = msg
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let need_fallback_content =
            !self.streamed_current_msg || self.current_msg_id != msg_id;

        if let Some(content) = msg.get("content").and_then(|v| v.as_array()) {
            let mut started_fallback = false;
            for block in content {
                let bt = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match bt {
                    "text" if need_fallback_content => {
                        let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            if !started_fallback {
                                out.push(UnifiedEvent::AssistantStart {
                                    message_id: msg_id.clone(),
                                });
                                started_fallback = true;
                            }
                            out.push(UnifiedEvent::TextDelta {
                                delta: text.to_string(),
                            });
                        }
                    }
                    "thinking" if need_fallback_content => {
                        let thinking = block
                            .get("thinking")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !thinking.is_empty() {
                            if !started_fallback {
                                out.push(UnifiedEvent::AssistantStart {
                                    message_id: msg_id.clone(),
                                });
                                started_fallback = true;
                            }
                            out.push(UnifiedEvent::ThinkingDelta {
                                delta: thinking.to_string(),
                            });
                        }
                    }
                    "tool_use" => {
                        let tool_call_id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !tool_call_id.is_empty() && self.seen_tool_ids.insert(tool_call_id.clone())
                        {
                            let tool_name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let args = block.get("input").cloned().unwrap_or(Value::Null);
                            out.push(UnifiedEvent::ToolStart {
                                tool_call_id,
                                tool_name,
                                args,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        // 结算当前 assistant 消息: 同一 message.id 只结算一次 usage, 防多块快照重复计数
        let already_settled = msg_id
            .as_ref()
            .map(|id| self.settled_msg_ids.contains(id))
            .unwrap_or(false);
        let usage = if !already_settled {
            msg.get("usage").map(parse_claude_usage)
        } else {
            None
        };
        if let (Some(id), Some(_)) = (msg_id.as_ref(), usage.as_ref()) {
            self.settled_msg_ids.insert(id.clone());
            self.turn_had_usage = true;
        }
        let stop_reason = msg
            .get("stop_reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if usage.is_some() || stop_reason.is_some() || self.streamed_current_msg {
            out.push(UnifiedEvent::AssistantEnd {
                usage,
                stop_reason,
                error_message: None,
            });
            self.streamed_current_msg = false;
            self.current_msg_id = None;
        }

        out
    }

    fn handle_user(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let Some(content) = frame
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                continue;
            }
            let tool_call_id = block
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if tool_call_id.is_empty() {
                continue;
            }
            let is_error = block
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let raw_content = block.get("content").cloned().unwrap_or(Value::Null);
            // 对齐前端 StepDetail 期望的 { content: [{ type: "text", text }] } 结构
            let normalized_result = normalize_tool_result_content(raw_content);
            out.push(UnifiedEvent::ToolEnd {
                tool_call_id,
                is_error,
                result: normalized_result,
            });
        }
        out
    }

    fn handle_result(&mut self, frame: &Value) -> Vec<UnifiedEvent> {
        let mut out = Vec::new();
        let is_error = frame
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if is_error {
            let msg = frame
                .get("result")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Claude Code 执行失败");
            out.push(UnifiedEvent::Notice {
                id: None,
                notify_type: NotifyLevel::Error,
                message: msg.to_string(),
                from_extension: false,
            });
        }

        // 若本轮未从 assistant 拿到 usage (或 result 补充了权威 total_cost_usd), 补发一次结算
        let cost = frame.get("total_cost_usd").and_then(|v| v.as_f64());
        if !self.turn_had_usage {
            if let Some(u) = frame.get("usage") {
                let mut parsed = parse_claude_usage(u);
                parsed.cost = cost;
                out.push(UnifiedEvent::AssistantEnd {
                    usage: Some(parsed),
                    stop_reason: None,
                    error_message: None,
                });
            }
        } else if let Some(c) = cost {
            // 本轮已加过 token, 只补权威成本
            if c > 0.0 {
                out.push(UnifiedEvent::AssistantEnd {
                    usage: Some(MessageUsage {
                        input: 0,
                        output: 0,
                        cache_read: 0,
                        cache_write: 0,
                        cost: Some(c),
                    }),
                    stop_reason: None,
                    error_message: None,
                });
            }
        }

        out.push(UnifiedEvent::TurnSettled);
        self.in_turn = false;
        self.streamed_current_msg = false;
        self.current_msg_id = None;
        self.seen_tool_ids.clear();
        self.settled_msg_ids.clear();
        self.turn_had_usage = false;
        out
    }

    fn handle_control_request(&self, frame: &Value) -> Vec<UnifiedEvent> {
        let request_id = frame
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let Some(req) = frame.get("request") else {
            return Vec::new();
        };
        let subtype = req.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
        if subtype != "can_use_tool" || request_id.is_empty() {
            return Vec::new();
        }
        let tool_name = req
            .get("display_name")
            .or_else(|| req.get("tool_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("工具")
            .to_string();
        let tool_call_id = req
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let description = req
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let input = req.get("input").cloned().unwrap_or(Value::Null);
        let options = req
            .get("permission_suggestions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .enumerate()
                    .filter_map(|(i, s)| {
                        let label = s
                            .get("label")
                            .or_else(|| s.get("type"))
                            .and_then(|v| v.as_str())?
                            .to_string();
                        let kind = s
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("allow_always")
                            .to_string();
                        Some(PermissionOption {
                            id: format!("suggestion-{i}"),
                            label,
                            kind,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        vec![UnifiedEvent::PermissionRequest {
            request: PermissionRequestPayload {
                id: request_id,
                tool_name,
                tool_call_id,
                description,
                input,
                options,
            },
        }]
    }
}

pub fn parse_claude_usage(u: &Value) -> MessageUsage {
    MessageUsage {
        input: u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        output: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        cache_read: u
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cache_write: u
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cost: None,
    }
}

pub fn normalize_tool_result_content(raw: Value) -> Value {
    match raw {
        Value::String(s) => serde_json::json!({
            "content": [{ "type": "text", "text": s }]
        }),
        Value::Array(arr) => serde_json::json!({ "content": arr }),
        other => serde_json::json!({
            "content": [{ "type": "text", "text": other.to_string() }]
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn translates_full_claude_stream_turn() {
        let mut tr = ClaudeStreamTranslator::new();

        // 1. system init
        let init = tr.translate(&json!({
            "type": "system",
            "subtype": "init",
            "session_id": "cc-123",
            "model": "claude-sonnet-4-6",
            "permissionMode": "auto"
        }));
        assert_eq!(
            init,
            vec![UnifiedEvent::SessionMeta {
                session_path: None,
                remote_session_id: Some("cc-123".into()),
                model: Some("claude-sonnet-4-6".into()),
                permission_mode: Some("auto".into()),
            }]
        );

        // 2. stream_event message_start + thinking + text + tool_use
        let ms = tr.translate(&json!({
            "type": "stream_event",
            "event": { "type": "message_start", "message": { "id": "msg_1", "usage": { "input_tokens": 10, "output_tokens": 1 } } }
        }));
        assert_eq!(ms[0], UnifiedEvent::TurnStart);
        assert_eq!(
            ms[1],
            UnifiedEvent::AssistantStart {
                message_id: Some("msg_1".into())
            }
        );
        assert_eq!(
            ms[2],
            UnifiedEvent::LiveUsage {
                input: 10,
                output: 1
            }
        );

        assert_eq!(
            tr.translate(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_start", "content_block": { "type": "thinking" } }
            })),
            vec![UnifiedEvent::ContentBlockStart {
                block: ContentBlockKind::Thinking
            }]
        );
        assert_eq!(
            tr.translate(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "thinking_delta", "thinking": "hmm" } }
            })),
            vec![UnifiedEvent::ThinkingDelta {
                delta: "hmm".into()
            }]
        );
        assert_eq!(
            tr.translate(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "hi" } }
            })),
            vec![UnifiedEvent::TextDelta { delta: "hi".into() }]
        );
        assert_eq!(
            tr.translate(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": "{\"a\"" } }
            })),
            vec![UnifiedEvent::ToolCallDelta { has_delta: true }]
        );

        // 3. assistant snapshot carries tool_use + usage (same msg_id only settles usage once)
        let asst = tr.translate(&json!({
            "type": "assistant",
            "message": {
                "id": "msg_1",
                "stop_reason": "tool_use",
                "content": [{ "type": "tool_use", "id": "tu_1", "name": "Bash", "input": { "command": "ls" } }],
                "usage": { "input_tokens": 50, "output_tokens": 30, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 5 }
            }
        }));
        assert_eq!(
            asst[0],
            UnifiedEvent::ToolStart {
                tool_call_id: "tu_1".into(),
                tool_name: "Bash".into(),
                args: json!({ "command": "ls" }),
            }
        );
        assert_eq!(
            asst[1],
            UnifiedEvent::AssistantEnd {
                usage: Some(MessageUsage {
                    input: 50,
                    output: 30,
                    cache_read: 20,
                    cache_write: 5,
                    cost: None,
                }),
                stop_reason: Some("tool_use".into()),
                error_message: None,
            }
        );

        // 4. user tool_result
        let tr_ev = tr.translate(&json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": "tu_1", "content": "ok", "is_error": false }]
            }
        }));
        assert_eq!(
            tr_ev,
            vec![UnifiedEvent::ToolEnd {
                tool_call_id: "tu_1".into(),
                is_error: false,
                result: json!({ "content": [{ "type": "text", "text": "ok" }] }),
            }]
        );

        // 5. result settles turn & attaches total_cost_usd
        let res = tr.translate(&json!({
            "type": "result",
            "is_error": false,
            "total_cost_usd": 0.0123
        }));
        assert!(res.iter().any(|e| matches!(e, UnifiedEvent::TurnSettled)));
    }

    #[test]
    fn translates_permission_control_request() {
        let mut tr = ClaudeStreamTranslator::new();
        let evs = tr.translate(&json!({
            "type": "control_request",
            "request_id": "req_42",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "display_name": "Bash",
                "description": "Run tests",
                "tool_use_id": "tu_9",
                "input": { "command": "npm test" },
                "permission_suggestions": [{ "type": "allow", "label": "Always allow Bash" }]
            }
        }));
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            UnifiedEvent::PermissionRequest { request } => {
                assert_eq!(request.id, "req_42");
                assert_eq!(request.tool_name, "Bash");
                assert_eq!(request.description.as_deref(), Some("Run tests"));
                assert_eq!(request.options.len(), 1);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
