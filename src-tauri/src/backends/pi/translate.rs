//! PI 原生 JSON 事件帧 → `UnifiedEvent` 纯函数翻译层。
//!
//! 一条 `message_update` 帧可能同时携带实时 `usage` 与 `assistantMessageEvent`,
//! 故返回 `Vec<UnifiedEvent>` (0~2 条), 保证无损保留原有语义。

use crate::backends::{ContentBlockKind, MessageUsage, NotifyLevel, UnifiedEvent};
use serde_json::Value;

fn parse_notify_level(raw: Option<&str>) -> NotifyLevel {
    match raw {
        Some("warning") => NotifyLevel::Warning,
        Some("error") => NotifyLevel::Error,
        _ => NotifyLevel::Info,
    }
}

fn parse_string_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// 将单条来自 `pi --mode rpc` stdout 的非 response 事件帧翻译为 0..N 条标准事件。
pub fn translate_pi_frame(frame: &Value) -> Vec<UnifiedEvent> {
    let Some(ev_type) = frame.get("type").and_then(|v| v.as_str()) else {
        return Vec::new();
    };

    match ev_type {
        "agent_start" => vec![UnifiedEvent::TurnStart],

        "message_start" => {
            let msg = frame.get("message");
            if msg.and_then(|m| m.get("role")).and_then(|r| r.as_str()) == Some("assistant") {
                let message_id = msg
                    .and_then(|m| m.get("id"))
                    .and_then(|id| id.as_str())
                    .map(|s| s.to_string());
                vec![UnifiedEvent::AssistantStart { message_id }]
            } else {
                Vec::new()
            }
        }

        "message_update" => {
            let mut out = Vec::with_capacity(2);
            if let Some(u) = frame.get("usage") {
                let input = u.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
                let output = u.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
                if input > 0 || output > 0 {
                    out.push(UnifiedEvent::LiveUsage { input, output });
                }
            }
            if let Some(ev) = frame.get("assistantMessageEvent") {
                let sub = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let delta = ev.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                match sub {
                    "text_start" => out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Text,
                    }),
                    "thinking_start" => out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Thinking,
                    }),
                    "toolcall_start" => out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::ToolCall,
                    }),
                    "text_delta" => out.push(UnifiedEvent::TextDelta {
                        delta: delta.to_string(),
                    }),
                    "thinking_delta" => out.push(UnifiedEvent::ThinkingDelta {
                        delta: delta.to_string(),
                    }),
                    "toolcall_delta" => out.push(UnifiedEvent::ToolCallDelta {
                        has_delta: !delta.is_empty(),
                    }),
                    _ => {}
                }
            }
            out
        }

        "message_end" => {
            let Some(msg) = frame.get("message") else {
                return Vec::new();
            };
            if msg.get("role").and_then(|v| v.as_str()) != Some("assistant") {
                return Vec::new();
            }
            let usage = msg.get("usage").map(|u| MessageUsage {
                input: u.get("input").and_then(|v| v.as_u64()).unwrap_or(0),
                output: u.get("output").and_then(|v| v.as_u64()).unwrap_or(0),
                cache_read: u.get("cacheRead").and_then(|v| v.as_u64()).unwrap_or(0),
                cache_write: u.get("cacheWrite").and_then(|v| v.as_u64()).unwrap_or(0),
                cost: u
                    .get("cost")
                    .and_then(|c| c.get("total"))
                    .and_then(|v| v.as_f64()),
            });
            let stop_reason = msg
                .get("stopReason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let error_message = msg
                .get("errorMessage")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            vec![UnifiedEvent::AssistantEnd {
                usage,
                stop_reason,
                error_message,
            }]
        }

        "tool_execution_start" => {
            let tool_call_id = frame
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_name = frame
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args = frame.get("args").cloned().unwrap_or(Value::Null);
            vec![UnifiedEvent::ToolStart {
                tool_call_id,
                tool_name,
                args,
            }]
        }

        "tool_execution_update" => {
            let tool_call_id = frame
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let partial_result = frame.get("partialResult").cloned().unwrap_or(Value::Null);
            vec![UnifiedEvent::ToolUpdate {
                tool_call_id,
                partial_result,
            }]
        }

        "tool_execution_end" => {
            let tool_call_id = frame
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = frame
                .get("isError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result = frame.get("result").cloned().unwrap_or(Value::Null);
            vec![UnifiedEvent::ToolEnd {
                tool_call_id,
                is_error,
                result,
            }]
        }

        "auto_retry_start" => {
            let attempt = frame.get("attempt").and_then(|v| v.as_u64()).unwrap_or(1);
            let max_attempts = frame
                .get("maxAttempts")
                .and_then(|v| v.as_u64())
                .unwrap_or(1);
            let error_message = frame
                .get("errorMessage")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            vec![UnifiedEvent::RetryStart {
                attempt,
                max_attempts,
                error_message,
            }]
        }

        "auto_retry_end" => {
            let success = frame
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let attempt = frame.get("attempt").and_then(|v| v.as_u64()).unwrap_or(0);
            let final_error = frame
                .get("finalError")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            vec![UnifiedEvent::RetryEnd {
                success,
                attempt,
                final_error,
            }]
        }

        "extension_error" => {
            let ext_path = frame
                .get("extensionPath")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("未知扩展");
            let err = frame
                .get("error")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("无详细信息");
            vec![UnifiedEvent::Notice {
                id: None,
                notify_type: NotifyLevel::Warning,
                message: format!("扩展出错 ({ext_path}): {err}"),
                from_extension: false,
            }]
        }

        "compaction_end" => {
            if let Some(err) = frame
                .get("errorMessage")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                vec![UnifiedEvent::Notice {
                    id: None,
                    notify_type: NotifyLevel::Warning,
                    message: format!("上下文压缩失败: {err}"),
                    from_extension: false,
                }]
            } else {
                Vec::new()
            }
        }

        "queue_update" => vec![UnifiedEvent::QueueUpdate {
            steering: parse_string_array(frame.get("steering")),
            follow_up: parse_string_array(frame.get("followUp")),
        }],

        "extension_ui_request" => {
            let method = frame.get("method").and_then(|v| v.as_str()).unwrap_or("");
            match method {
                "confirm" | "select" | "input" | "editor" => vec![UnifiedEvent::UiRequest {
                    request: frame.clone(),
                }],
                "notify" => {
                    let id = frame
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let message = frame
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let notify_type =
                        parse_notify_level(frame.get("notifyType").and_then(|v| v.as_str()));
                    vec![UnifiedEvent::Notice {
                        id,
                        notify_type,
                        message,
                        from_extension: true,
                    }]
                }
                _ => Vec::new(),
            }
        }

        "agent_settled" => vec![UnifiedEvent::TurnSettled],

        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn translates_agent_lifecycle_and_assistant_start() {
        assert_eq!(
            translate_pi_frame(&json!({ "type": "agent_start" })),
            vec![UnifiedEvent::TurnStart]
        );
        assert_eq!(
            translate_pi_frame(&json!({
                "type": "message_start",
                "message": { "role": "assistant", "id": "m-1" }
            })),
            vec![UnifiedEvent::AssistantStart {
                message_id: Some("m-1".into())
            }]
        );
        // user message_start 忽略
        assert!(translate_pi_frame(&json!({
            "type": "message_start",
            "message": { "role": "user" }
        }))
        .is_empty());
        assert_eq!(
            translate_pi_frame(&json!({ "type": "agent_settled" })),
            vec![UnifiedEvent::TurnSettled]
        );
    }

    #[test]
    fn translates_message_update_dual_payload() {
        let out = translate_pi_frame(&json!({
            "type": "message_update",
            "usage": { "input": 120, "output": 45 },
            "assistantMessageEvent": { "type": "text_delta", "delta": "hello" }
        }));
        assert_eq!(
            out,
            vec![
                UnifiedEvent::LiveUsage {
                    input: 120,
                    output: 45
                },
                UnifiedEvent::TextDelta {
                    delta: "hello".into()
                }
            ]
        );

        assert_eq!(
            translate_pi_frame(&json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "toolcall_start" }
            })),
            vec![UnifiedEvent::ContentBlockStart {
                block: ContentBlockKind::ToolCall
            }]
        );

        assert_eq!(
            translate_pi_frame(&json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "toolcall_delta", "delta": "{\"a\":1}" }
            })),
            vec![UnifiedEvent::ToolCallDelta { has_delta: true }]
        );
    }

    #[test]
    fn translates_message_end_with_usage_and_error() {
        let out = translate_pi_frame(&json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "error",
                "errorMessage": "rate limit",
                "usage": {
                    "input": 100,
                    "output": 20,
                    "cacheRead": 50,
                    "cacheWrite": 10,
                    "cost": { "total": 0.0042 }
                }
            }
        }));
        assert_eq!(
            out,
            vec![UnifiedEvent::AssistantEnd {
                usage: Some(MessageUsage {
                    input: 100,
                    output: 20,
                    cache_read: 50,
                    cache_write: 10,
                    cost: Some(0.0042),
                }),
                stop_reason: Some("error".into()),
                error_message: Some("rate limit".into()),
            }]
        );
    }

    #[test]
    fn translates_tools_retry_queue_and_ui_requests() {
        assert_eq!(
            translate_pi_frame(&json!({
                "type": "tool_execution_start",
                "toolCallId": "tc1",
                "toolName": "bash",
                "args": { "cmd": "ls" }
            })),
            vec![UnifiedEvent::ToolStart {
                tool_call_id: "tc1".into(),
                tool_name: "bash".into(),
                args: json!({ "cmd": "ls" })
            }]
        );
        assert_eq!(
            translate_pi_frame(&json!({
                "type": "tool_execution_end",
                "toolCallId": "tc1",
                "isError": true,
                "result": { "content": [] }
            })),
            vec![UnifiedEvent::ToolEnd {
                tool_call_id: "tc1".into(),
                is_error: true,
                result: json!({ "content": [] })
            }]
        );
        assert_eq!(
            translate_pi_frame(&json!({
                "type": "queue_update",
                "steering": ["a"],
                "followUp": ["b"]
            })),
            vec![UnifiedEvent::QueueUpdate {
                steering: vec!["a".into()],
                follow_up: vec!["b".into()],
            }]
        );
        assert_eq!(
            translate_pi_frame(&json!({
                "type": "extension_ui_request",
                "id": "n1",
                "method": "notify",
                "notifyType": "warning",
                "message": "heads up"
            })),
            vec![UnifiedEvent::Notice {
                id: Some("n1".into()),
                notify_type: NotifyLevel::Warning,
                message: "heads up".into(),
                from_extension: true,
            }]
        );
        // 未知的 extension_ui_request method 忽略
        assert!(translate_pi_frame(&json!({
            "type": "extension_ui_request",
            "method": "setStatus"
        }))
        .is_empty());
        // compaction 成功无 errorMessage 忽略
        assert!(translate_pi_frame(&json!({ "type": "compaction_end" })).is_empty());
        assert_eq!(
            translate_pi_frame(&json!({ "type": "compaction_end", "errorMessage": "quota" })),
            vec![UnifiedEvent::Notice {
                id: None,
                notify_type: NotifyLevel::Warning,
                message: "上下文压缩失败: quota".into(),
                from_extension: false,
            }]
        );
    }
}
