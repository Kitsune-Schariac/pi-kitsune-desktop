//! ACP (Agent Client Protocol, JSON-RPC 2.0 over stdio) v1 协议构造与事件翻译纯函数。
//!
//! 规范覆盖:
//! - Client → Agent: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`
//! - Agent → Client Notification: `session/update` (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`)
//! - Agent → Client Request: `session/request_permission` ↔ `RequestPermissionResponse`

use crate::backends::{
    ContentBlockKind, PermissionOption, PermissionRequestPayload, UnifiedEvent,
};
use serde_json::{json, Value};

pub fn build_initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": {
                    "readTextFile": false,
                    "writeTextFile": false
                },
                "terminal": false
            },
            "clientInfo": {
                "name": "pi-kitsune-desktop",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    })
}

pub fn build_session_new_request(id: u64, cwd: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/new",
        "params": {
            "cwd": cwd,
            "mcpServers": []
        }
    })
}

pub fn build_session_load_request(id: u64, session_id: &str, cwd: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/load",
        "params": {
            "sessionId": session_id,
            "cwd": cwd,
            "mcpServers": []
        }
    })
}

pub fn build_session_prompt_request(
    id: u64,
    session_id: &str,
    message: &str,
    images: Option<&[Value]>,
) -> Value {
    let mut prompt = Vec::new();
    if let Some(imgs) = images {
        for img in imgs {
            if let (Some(data), Some(mime)) = (
                img.get("data").and_then(|v| v.as_str()),
                img.get("mimeType").and_then(|v| v.as_str()),
            ) {
                prompt.push(json!({
                    "type": "image",
                    "data": data,
                    "mimeType": mime
                }));
            }
        }
    }
    prompt.push(json!({
        "type": "text",
        "text": message
    }));
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": prompt
        }
    })
}

pub fn build_session_cancel_notification(session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": {
            "sessionId": session_id
        }
    })
}

/// 构造 ACP `session/request_permission` 的 JSON-RPC 2.0 响应帧。
pub fn build_permission_response(
    rpc_id: Value,
    allow: bool,
    chosen_option_id: Option<&str>,
    available_options: &[PermissionOption],
) -> Value {
    let outcome = if allow {
        let selected = chosen_option_id
            .map(|s| s.to_string())
            .or_else(|| {
                available_options
                    .iter()
                    .find(|o| o.kind.eq_ignore_ascii_case("allow_once"))
                    .or_else(|| {
                        available_options
                            .iter()
                            .find(|o| o.kind.to_ascii_lowercase().contains("allow"))
                    })
                    .or_else(|| available_options.first())
                    .map(|o| o.id.clone())
            });
        match selected {
            Some(opt_id) => json!({ "outcome": "selected", "optionId": opt_id }),
            None => json!({ "outcome": "cancelled" }),
        }
    } else {
        // 优先匹配 reject_once 选项, 无匹配时走标准 cancelled
        match available_options
            .iter()
            .find(|o| o.kind.eq_ignore_ascii_case("reject_once"))
            .map(|o| o.id.clone())
        {
            Some(opt_id) => json!({ "outcome": "selected", "optionId": opt_id }),
            None => json!({ "outcome": "cancelled" }),
        }
    };

    json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": {
            "outcome": outcome
        }
    })
}

/// 将 ACP `tool_call_update` 的 `content` / `rawOutput` 规整为前端 StepDetail 可展示结构。
fn normalize_acp_tool_output(update: &Value) -> Value {
    if let Some(raw) = update.get("rawOutput") {
        if !raw.is_null() {
            return match raw {
                Value::String(s) => json!({ "content": [{ "type": "text", "text": s }] }),
                other => json!({ "content": [{ "type": "text", "text": other.to_string() }] }),
            };
        }
    }
    if let Some(arr) = update.get("content").and_then(|v| v.as_array()) {
        let mut texts = Vec::new();
        for item in arr {
            if let Some(t) = item
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .or_else(|| item.get("text").and_then(|v| v.as_str()))
            {
                texts.push(json!({ "type": "text", "text": t }));
            }
        }
        if !texts.is_empty() {
            return json!({ "content": texts });
        }
    }
    json!({ "content": [] })
}

/// 翻译 ACP `session/update` 通知的 `params` → 0..N 条 `UnifiedEvent`。
pub fn translate_acp_update(params: &Value) -> Vec<UnifiedEvent> {
    let Some(update) = params.get("update") else {
        return Vec::new();
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match kind {
        "agent_message_chunk" => {
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if text.is_empty() {
                Vec::new()
            } else {
                vec![
                    UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Text,
                    },
                    UnifiedEvent::TextDelta {
                        delta: text.to_string(),
                    },
                ]
            }
        }
        "agent_thought_chunk" => {
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if text.is_empty() {
                Vec::new()
            } else {
                vec![
                    UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Thinking,
                    },
                    UnifiedEvent::ThinkingDelta {
                        delta: text.to_string(),
                    },
                ]
            }
        }
        "tool_call" => {
            let tool_call_id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if tool_call_id.is_empty() {
                return Vec::new();
            }
            let tool_name = update
                .get("title")
                .or_else(|| update.get("kind"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let args = update.get("rawInput").cloned().unwrap_or(Value::Null);
            vec![UnifiedEvent::ToolStart {
                tool_call_id,
                tool_name,
                args,
            }]
        }
        "tool_call_update" => {
            let tool_call_id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if tool_call_id.is_empty() {
                return Vec::new();
            }
            let status = update.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let output = normalize_acp_tool_output(update);
            match status {
                "completed" => vec![UnifiedEvent::ToolEnd {
                    tool_call_id,
                    is_error: false,
                    result: output,
                }],
                "failed" | "error" => vec![UnifiedEvent::ToolEnd {
                    tool_call_id,
                    is_error: true,
                    result: output,
                }],
                _ => vec![UnifiedEvent::ToolUpdate {
                    tool_call_id,
                    partial_result: output,
                }],
            }
        }
        _ => Vec::new(),
    }
}

/// 翻译 ACP 反向请求 `session/request_permission` → 统一 `PermissionRequestPayload`。
pub fn translate_acp_permission_request(
    request_key: String,
    params: &Value,
) -> PermissionRequestPayload {
    let tc = params.get("toolCall");
    let tool_name = tc
        .and_then(|t| t.get("title").or_else(|| t.get("kind")))
        .and_then(|v| v.as_str())
        .unwrap_or("工具调用")
        .to_string();
    let tool_call_id = tc
        .and_then(|t| t.get("toolCallId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let input = tc
        .and_then(|t| t.get("rawInput"))
        .cloned()
        .unwrap_or(Value::Null);
    let options = params
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    let id = o.get("optionId").and_then(|v| v.as_str())?.to_string();
                    let label = o
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let kind = o
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or("allow_once")
                        .to_string();
                    Some(PermissionOption { id, label, kind })
                })
                .collect()
        })
        .unwrap_or_default();

    PermissionRequestPayload {
        id: request_key,
        tool_name,
        tool_call_id,
        description: None,
        input,
        options,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_valid_acp_jsonrpc_requests() {
        let init = build_initialize_request(1);
        assert_eq!(init["jsonrpc"], "2.0");
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["protocolVersion"], 1);

        let sn = build_session_new_request(2, r"C:\proj");
        assert_eq!(sn["method"], "session/new");
        assert_eq!(sn["params"]["cwd"], r"C:\proj");

        let sp = build_session_prompt_request(3, "s1", "hello", None);
        assert_eq!(sp["method"], "session/prompt");
        assert_eq!(sp["params"]["prompt"][0]["text"], "hello");

        let cancel = build_session_cancel_notification("s1");
        assert_eq!(cancel["method"], "session/cancel");
        assert!(cancel.get("id").is_none());
    }

    #[test]
    fn translates_acp_session_updates() {
        let msg = translate_acp_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hi!" }
            }
        }));
        assert_eq!(
            msg,
            vec![
                UnifiedEvent::ContentBlockStart {
                    block: ContentBlockKind::Text
                },
                UnifiedEvent::TextDelta {
                    delta: "hi!".into()
                }
            ]
        );

        let thought = translate_acp_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "thinking" }
            }
        }));
        assert_eq!(
            thought[1],
            UnifiedEvent::ThinkingDelta {
                delta: "thinking".into()
            }
        );

        let tc = translate_acp_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tc-1",
                "title": "Run shell",
                "rawInput": { "cmd": "dir" }
            }
        }));
        assert_eq!(
            tc,
            vec![UnifiedEvent::ToolStart {
                tool_call_id: "tc-1".into(),
                tool_name: "Run shell".into(),
                args: json!({ "cmd": "dir" }),
            }]
        );

        let done = translate_acp_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "tc-1",
                "status": "completed",
                "rawOutput": "ok"
            }
        }));
        assert_eq!(
            done,
            vec![UnifiedEvent::ToolEnd {
                tool_call_id: "tc-1".into(),
                is_error: false,
                result: json!({ "content": [{ "type": "text", "text": "ok" }] }),
            }]
        );
    }

    #[test]
    fn translates_permission_and_builds_response() {
        let payload = translate_acp_permission_request(
            "acp-perm-1".into(),
            &json!({
                "toolCall": {
                    "toolCallId": "tc-9",
                    "title": "Edit file",
                    "rawInput": { "path": "a.rs" }
                },
                "options": [
                    { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
                    { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" }
                ]
            }),
        );
        assert_eq!(payload.tool_name, "Edit file");
        assert_eq!(payload.options.len(), 2);

        let allow_resp = build_permission_response(json!(7), true, None, &payload.options);
        assert_eq!(allow_resp["id"], 7);
        assert_eq!(allow_resp["result"]["outcome"]["optionId"], "allow_once");

        let deny_resp = build_permission_response(json!(7), false, None, &payload.options);
        assert_eq!(deny_resp["result"]["outcome"]["optionId"], "reject_once");
    }
}
