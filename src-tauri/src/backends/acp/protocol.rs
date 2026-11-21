//! ACP (Agent Client Protocol, JSON-RPC 2.0 over stdio) v1 协议构造与事件翻译纯函数。
//!
//! 规范覆盖:
//! - Client → Agent: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`,
//!   `session/set_config_option`, `session/set_mode`
//! - Agent → Client Notification: `session/update` (`agent_message_chunk`, `agent_thought_chunk`,
//!   `tool_call`, `tool_call_update`, `config_option_update`, `current_mode_update`)
//! - Agent → Client Request: `session/request_permission` ↔ `RequestPermissionResponse`

use crate::backends::{
    ContentBlockKind, PermissionOption, PermissionRequestPayload, UnifiedEvent,
};
use serde_json::{json, Value};

/// Antigravity ACP 默认支持的权限/执行模式枚举 (与 `agy acp` `session/new` 返回的 `modes` 对齐)。
pub const ACP_PERMISSION_MODES: &[&str] = &["default", "accept-edits", "auto", "plan"];

/// ACP select 类别配置项的单个候选项 (模型 / 模式等)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpSelectOption {
    pub value: String,
    pub name: String,
}

/// ACP 会话运行时配置快照: 统一承接 `configOptions` (优先) 及兼容 `models` / `modes`。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AcpSessionConfig {
    pub model_config_id: Option<String>,
    pub current_model_id: Option<String>,
    pub models: Vec<AcpSelectOption>,

    pub thought_config_id: Option<String>,
    pub current_thought_level: Option<String>,
    pub thought_levels: Vec<String>,

    pub mode_config_id: Option<String>,
    pub current_mode_id: Option<String>,
    pub modes: Vec<AcpSelectOption>,
}

impl AcpSessionConfig {
    pub fn display_name_for_model(&self, model_id: &str) -> String {
        self.models
            .iter()
            .find(|m| m.value == model_id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| model_id.to_string())
    }

    pub fn effective_thought_levels(&self) -> Vec<String> {
        if self.thought_levels.is_empty() {
            vec!["off".to_string()]
        } else {
            self.thought_levels.clone()
        }
    }

    pub fn effective_thought_level(&self) -> String {
        if self.thought_levels.is_empty() {
            "off".to_string()
        } else {
            self.current_thought_level
                .clone()
                .filter(|v| self.thought_levels.iter().any(|lv| lv == v))
                .or_else(|| self.thought_levels.first().cloned())
                .unwrap_or_else(|| "off".to_string())
        }
    }

    pub fn mode_ids(&self) -> Vec<String> {
        self.modes.iter().map(|m| m.value.clone()).collect()
    }
}

fn parse_select_options(arr: &[Value]) -> Vec<AcpSelectOption> {
    arr.iter()
        .filter_map(|item| {
            let value = item
                .get("value")
                .or_else(|| item.get("id"))
                .or_else(|| item.get("modelId"))
                .and_then(|v| v.as_str())?
                .trim()
                .to_string();
            if value.is_empty() {
                return None;
            }
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&value)
                .to_string();
            Some(AcpSelectOption { value, name })
        })
        .collect()
}

/// 将完整 `configOptions` 快照合并进 `AcpSessionConfig`。
/// 注意: 切到不支持思考档位的模型时, 服务端会从 `configOptions` 省略 `thought_level`,
/// 因此每次快照必须显式检测本轮是否出现 `thought_level`, 未出现则清空为 `"off"`。
pub fn apply_config_options(cfg: &mut AcpSessionConfig, config_options: &[Value]) {
    let mut saw_thought = false;
    for opt in config_options {
        let id = opt.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let category = opt.get("category").and_then(|v| v.as_str()).unwrap_or(id);
        let current = opt
            .get("currentValue")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let options = opt
            .get("options")
            .and_then(|v| v.as_array())
            .map(|a| parse_select_options(a))
            .unwrap_or_default();

        match category {
            "model" => {
                if !id.is_empty() {
                    cfg.model_config_id = Some(id.to_string());
                }
                if let Some(cur) = current {
                    cfg.current_model_id = Some(cur);
                }
                if !options.is_empty() {
                    cfg.models = options;
                }
            }
            "thought_level" => {
                saw_thought = true;
                if !id.is_empty() {
                    cfg.thought_config_id = Some(id.to_string());
                }
                cfg.thought_levels = options.into_iter().map(|o| o.value).collect();
                cfg.current_thought_level = current;
            }
            "mode" => {
                if !id.is_empty() {
                    cfg.mode_config_id = Some(id.to_string());
                }
                if let Some(cur) = current {
                    cfg.current_mode_id = Some(cur);
                }
                if !options.is_empty() {
                    cfg.modes = options;
                }
            }
            _ => {}
        }
    }

    if !saw_thought {
        cfg.thought_config_id = None;
        cfg.thought_levels.clear();
        cfg.current_thought_level = Some("off".to_string());
    }
}

/// 从 `session/new` / `session/load` 的 `result` 解析初始配置快照:
/// 优先使用 `configOptions` (主模型列表 + 独立 `thought_level` + `mode`),
/// 缺失字段再回退到旧式 `models` / `modes`。
pub fn parse_session_config(result: &Value) -> AcpSessionConfig {
    let mut cfg = AcpSessionConfig::default();

    if let Some(arr) = result.get("configOptions").and_then(|v| v.as_array()) {
        if !arr.is_empty() {
            apply_config_options(&mut cfg, arr);
        }
    }

    if cfg.models.is_empty() {
        if let Some(models) = result.get("models") {
            if let Some(arr) = models.get("availableModels").and_then(|v| v.as_array()) {
                cfg.models = parse_select_options(arr);
            }
            if cfg.current_model_id.is_none() {
                cfg.current_model_id = models
                    .get("currentModelId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
        }
    }

    if cfg.modes.is_empty() {
        if let Some(modes) = result.get("modes") {
            if let Some(arr) = modes.get("availableModes").and_then(|v| v.as_array()) {
                cfg.modes = parse_select_options(arr);
            }
            if cfg.current_mode_id.is_none() {
                cfg.current_mode_id = modes
                    .get("currentModeId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
        }
    }

    cfg
}

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

pub fn build_set_config_option_request(
    id: u64,
    session_id: &str,
    config_id: &str,
    value: &str,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/set_config_option",
        "params": {
            "sessionId": session_id,
            "configId": config_id,
            "value": value
        }
    })
}

pub fn build_set_mode_request(id: u64, session_id: &str, mode_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/set_mode",
        "params": {
            "sessionId": session_id,
            "modeId": mode_id
        }
    })
}

pub fn build_set_model_request(id: u64, session_id: &str, model_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/set_model",
        "params": {
            "sessionId": session_id,
            "modelId": model_id
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

/// ACP `session/update` 中的 `usage_update` 载荷 (`{ sessionUpdate: "usage_update", used, size }`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcpUsageUpdate {
    pub used: u64,
    pub size: u64,
}

/// 解析 `usage_update` 帧，提取已用上下文与窗口上限。
pub fn parse_usage_update(update: &Value) -> Option<AcpUsageUpdate> {
    if update.get("sessionUpdate").and_then(|v| v.as_str()) != Some("usage_update") {
        return None;
    }
    let used = update.get("used").and_then(|v| v.as_u64())?;
    let size = update.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    Some(AcpUsageUpdate { used, size })
}

/// 将 `session/load` 期间缓冲的 `session/update`（每个元素为 `params.update` 对象）
/// 规整为与前端 `mapHistoryEntries` 100% 兼容的标准历史条目数组。
pub fn replay_updates_to_entries(updates: &[Value]) -> Vec<Value> {
    let mut entries: Vec<Value> = Vec::new();
    let mut seq: usize = 0;

    let mut cur_user = String::new();
    let mut cur_asst_thinking = String::new();
    let mut cur_asst_text = String::new();
    let mut cur_asst_tools: Vec<Value> = Vec::new();
    let mut seen_tool_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    let flush_user = |cur_user: &mut String, entries: &mut Vec<Value>, seq: &mut usize| {
        let text = std::mem::take(cur_user);
        if !text.trim().is_empty() {
            *seq += 1;
            entries.push(json!({
                "type": "message",
                "id": format!("acp-replay-u-{seq}"),
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": text }]
                }
            }));
        }
    };

    let flush_asst = |thinking: &mut String,
                      text: &mut String,
                      tools: &mut Vec<Value>,
                      entries: &mut Vec<Value>,
                      seq: &mut usize| {
        let th = std::mem::take(thinking);
        let tx = std::mem::take(text);
        let tcs = std::mem::take(tools);
        if th.is_empty() && tx.is_empty() && tcs.is_empty() {
            return;
        }
        let mut blocks = Vec::new();
        if !th.is_empty() {
            blocks.push(json!({ "type": "thinking", "thinking": th }));
        }
        if !tx.is_empty() {
            blocks.push(json!({ "type": "text", "text": tx }));
        }
        blocks.extend(tcs);
        *seq += 1;
        entries.push(json!({
            "type": "message",
            "id": format!("acp-replay-a-{seq}"),
            "message": {
                "role": "assistant",
                "content": blocks
            }
        }));
    };

    for update in updates {
        let kind = update
            .get("sessionUpdate")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        match kind {
            "user_message_chunk" => {
                flush_asst(
                    &mut cur_asst_thinking,
                    &mut cur_asst_text,
                    &mut cur_asst_tools,
                    &mut entries,
                    &mut seq,
                );
                if let Some(t) = update
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(|v| v.as_str())
                {
                    cur_user.push_str(t);
                }
            }
            "agent_thought_chunk" => {
                flush_user(&mut cur_user, &mut entries, &mut seq);
                if let Some(t) = update
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(|v| v.as_str())
                {
                    cur_asst_thinking.push_str(t);
                }
            }
            "agent_message_chunk" => {
                flush_user(&mut cur_user, &mut entries, &mut seq);
                if let Some(t) = update
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(|v| v.as_str())
                {
                    cur_asst_text.push_str(t);
                }
            }
            "tool_call" => {
                flush_user(&mut cur_user, &mut entries, &mut seq);
                let tool_call_id = update
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !tool_call_id.is_empty() && seen_tool_ids.insert(tool_call_id.clone()) {
                    let tool_name = update
                        .get("title")
                        .or_else(|| update.get("kind"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool");
                    let args = update.get("rawInput").cloned().unwrap_or(Value::Null);
                    cur_asst_tools.push(json!({
                        "type": "toolCall",
                        "id": tool_call_id,
                        "name": tool_name,
                        "arguments": args,
                    }));
                }
            }
            "tool_call_update" => {
                let status = update.get("status").and_then(|v| v.as_str()).unwrap_or("");
                if matches!(status, "completed" | "failed" | "error") {
                    flush_asst(
                        &mut cur_asst_thinking,
                        &mut cur_asst_text,
                        &mut cur_asst_tools,
                        &mut entries,
                        &mut seq,
                    );
                    let tool_call_id = update
                        .get("toolCallId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !tool_call_id.is_empty() {
                        let out = normalize_acp_tool_output(update);
                        seq += 1;
                        entries.push(json!({
                            "type": "message",
                            "id": format!("acp-replay-tr-{seq}"),
                            "message": {
                                "role": "toolResult",
                                "toolCallId": tool_call_id,
                                "isError": status != "completed",
                                "content": out.get("content").cloned().unwrap_or(json!([]))
                            }
                        }));
                    }
                }
            }
            _ => {}
        }
    }

    flush_user(&mut cur_user, &mut entries, &mut seq);
    flush_asst(
        &mut cur_asst_thinking,
        &mut cur_asst_text,
        &mut cur_asst_tools,
        &mut entries,
        &mut seq,
    );
    entries
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

    #[test]
    fn parses_config_options_and_clears_thought_level_when_omitted() {
        let result = json!({
            "sessionId": "s1",
            "configOptions": [
                {
                    "id": "model",
                    "category": "model",
                    "currentValue": "gemini-4-neon",
                    "options": [
                        { "value": "gemini-4-neon", "name": "Gemini 4 Neon" },
                        { "value": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)" }
                    ]
                },
                {
                    "id": "thought_level",
                    "category": "thought_level",
                    "currentValue": "high",
                    "options": [
                        { "value": "low", "name": "Low" },
                        { "value": "medium", "name": "Medium" },
                        { "value": "high", "name": "High" },
                        { "value": "xhigh", "name": "Extra" }
                    ]
                },
                {
                    "id": "mode",
                    "category": "mode",
                    "currentValue": "default",
                    "options": [
                        { "value": "default", "name": "Default" },
                        { "value": "accept-edits", "name": "Accept edits" },
                        { "value": "auto", "name": "Auto" },
                        { "value": "plan", "name": "Plan" }
                    ]
                }
            ]
        });

        let mut cfg = parse_session_config(&result);
        assert_eq!(cfg.current_model_id.as_deref(), Some("gemini-4-neon"));
        assert_eq!(cfg.display_name_for_model("gemini-4-neon"), "Gemini 4 Neon");
        assert_eq!(cfg.effective_thought_level(), "high");
        assert_eq!(
            cfg.effective_thought_levels(),
            vec!["low", "medium", "high", "xhigh"]
        );
        assert_eq!(cfg.current_mode_id.as_deref(), Some("default"));
        assert_eq!(cfg.mode_ids(), vec!["default", "accept-edits", "auto", "plan"]);

        // 切到不支持 thought_level 的模型时, 快照省略 thought_level -> 自动降为 off
        let updated = json!([
            {
                "id": "model",
                "category": "model",
                "currentValue": "gpt-oss-120b-medium",
                "options": [
                    { "value": "gemini-4-neon", "name": "Gemini 4 Neon" },
                    { "value": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)" }
                ]
            },
            {
                "id": "mode",
                "category": "mode",
                "currentValue": "auto",
                "options": [
                    { "value": "default", "name": "Default" },
                    { "value": "auto", "name": "Auto" }
                ]
            }
        ]);
        apply_config_options(&mut cfg, updated.as_array().unwrap());
        assert_eq!(cfg.current_model_id.as_deref(), Some("gpt-oss-120b-medium"));
        assert_eq!(cfg.effective_thought_levels(), vec!["off"]);
        assert_eq!(cfg.effective_thought_level(), "off");
        assert_eq!(cfg.current_mode_id.as_deref(), Some("auto"));

        let req = build_set_config_option_request(9, "s1", "model", "gemini-4-neon");
        assert_eq!(req["method"], "session/set_config_option");
        assert_eq!(req["params"]["configId"], "model");
        assert_eq!(req["params"]["value"], "gemini-4-neon");
    }

    #[test]
    fn parses_usage_update_and_replays_history_chunks() {
        let uu = parse_usage_update(&json!({
            "sessionUpdate": "usage_update",
            "used": 12174,
            "size": 1048576
        }))
        .unwrap();
        assert_eq!(uu, AcpUsageUpdate { used: 12174, size: 1048576 });

        let updates = vec![
            json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "你好" } }),
            json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "世界" } }),
            json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "先查一下" } }),
            json!({ "sessionUpdate": "tool_call", "toolCallId": "tc1", "title": "Read", "rawInput": { "path": "a.rs" } }),
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "tc1", "status": "completed", "rawOutput": "file body" }),
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "查完了" } }),
        ];
        let entries = replay_updates_to_entries(&updates);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0]["message"]["role"], "user");
        assert_eq!(entries[0]["message"]["content"][0]["text"], "你好世界");
        assert_eq!(entries[1]["message"]["role"], "assistant");
        assert_eq!(entries[1]["message"]["content"][0]["type"], "thinking");
        assert_eq!(entries[1]["message"]["content"][1]["type"], "toolCall");
        assert_eq!(entries[2]["message"]["role"], "toolResult");
        assert_eq!(entries[2]["message"]["toolCallId"], "tc1");
        assert_eq!(entries[3]["message"]["role"], "assistant");
        assert_eq!(entries[3]["message"]["content"][0]["text"], "查完了");
    }
}
