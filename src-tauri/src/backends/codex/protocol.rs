//! Codex CLI App Server (`codex app-server --stdio`, JSON-RPC 2.0 v2) 协议构造与事件翻译纯函数。
//!
//! 规范对齐实机 `codex-cli` (`codex app-server generate-ts`):
//! - Client → Server: `initialize`, `initialized`, `model/list`, `thread/start`, `thread/resume`,
//!   `thread/items/list`, `thread/name/set`, `turn/start`, `turn/steer`, `turn/interrupt`
//! - Server → Client Notification: `turn/started`, `turn/completed`, `turn/plan/updated`,
//!   `thread/tokenUsage/updated`, `item/started`, `item/completed`, `item/agentMessage/delta`,
//!   `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`,
//!   `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress`,
//!   `error`
//! - Server → Client Request: `item/commandExecution/requestApproval`,
//!   `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
//!   `item/tool/requestUserInput`, 以及旧版 `execCommandApproval` / `applyPatchApproval`

use crate::backends::plan::{PlanItem, PlanItemStatus, PlanSnapshot};
use crate::backends::prompt::{
    PromptOption, PromptQuestion, UserPromptKind, UserPromptRequest, UserPromptResponse,
};
use crate::backends::{
    ContentBlockKind, MessageUsage, NotifyLevel, PermissionOption, PermissionRequestPayload,
    UnifiedEvent,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// Codex 会话权限/沙箱组合模式 (前端一键切换枚举)。
pub const CODEX_PERMISSION_MODES: &[&str] = &["auto", "manual", "read-only", "full-access"];

/// Codex 支持的默认推理强度档位 (模型目录未返回时的兜底列表)。
pub const CODEX_EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh"];

/// Codex 模型目录单项 (由 `model/list` 解析)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexModelEntry {
    pub id: String,
    pub name: String,
    pub default_effort: Option<String>,
    pub supported_efforts: Vec<String>,
    pub is_default: bool,
}

/// 将权限模式名映射为 Codex `(approvalPolicy, sandboxMode)` (供 `thread/start` / `thread/resume`)。
pub fn mode_to_codex_thread_policy(mode: &str) -> (&'static str, &'static str) {
    match mode {
        "manual" => ("untrusted", "workspace-write"),
        "read-only" => ("on-request", "read-only"),
        "full-access" => ("never", "danger-full-access"),
        _ => ("on-request", "workspace-write"),
    }
}

/// 将权限模式名映射为 `turn/start` 所需的 `(approvalPolicy, sandboxPolicy)` JSON。
pub fn mode_to_codex_turn_policy(mode: &str, cwd: &str) -> (&'static str, Value) {
    match mode {
        "manual" => (
            "untrusted",
            json!({
                "type": "workspaceWrite",
                "writableRoots": [cwd],
                "networkAccess": false,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false,
            }),
        ),
        "read-only" => (
            "on-request",
            json!({
                "type": "readOnly",
                "networkAccess": false,
            }),
        ),
        "full-access" => ("never", json!({ "type": "dangerFullAccess" })),
        _ => (
            "on-request",
            json!({
                "type": "workspaceWrite",
                "writableRoots": [cwd],
                "networkAccess": false,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false,
            }),
        ),
    }
}

/// 从 `thread/start` 或 `thread/resume` 返回的 `approvalPolicy` + `sandbox` 反推统一模式名。
pub fn infer_mode_from_thread_response(result: &Value) -> String {
    let approval = result
        .get("approvalPolicy")
        .and_then(|v| v.as_str())
        .unwrap_or("on-request");
    let sandbox_type = result
        .get("sandbox")
        .and_then(|s| s.get("type").and_then(|v| v.as_str()).or_else(|| s.as_str()))
        .unwrap_or("workspaceWrite");

    match (approval, sandbox_type) {
        ("never", "dangerFullAccess" | "danger-full-access") => "full-access".to_string(),
        (_, "readOnly" | "read-only") => "read-only".to_string(),
        ("untrusted", _) => "manual".to_string(),
        _ => "auto".to_string(),
    }
}

/// 构造 `UserInput[]` (文本 + 图片 data URL)。
pub fn build_user_input(message: &str, images: Option<&[Value]>) -> Vec<Value> {
    let mut items = Vec::new();
    if let Some(imgs) = images {
        for img in imgs {
            if let (Some(data), Some(mime)) = (
                img.get("data").and_then(|v| v.as_str()),
                img.get("mimeType").and_then(|v| v.as_str()),
            ) {
                items.push(json!({
                    "type": "image",
                    "url": format!("data:{mime};base64,{data}"),
                }));
            }
        }
    }
    items.push(json!({
        "type": "text",
        "text": message,
        "text_elements": [],
    }));
    items
}

pub fn build_initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "pi-kitsune-desktop",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": {
                "experimentalApi": true,
                "requestAttestation": false,
            }
        }
    })
}

pub fn build_initialized_notification() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "initialized"
    })
}

pub fn build_model_list_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "model/list",
        "params": {
            "includeHidden": false
        }
    })
}

pub fn build_thread_start_request(
    id: u64,
    cwd: &str,
    model: Option<&str>,
    mode: &str,
) -> Value {
    let (approval, sandbox) = mode_to_codex_thread_policy(mode);
    let mut params = serde_json::Map::new();
    params.insert("cwd".into(), json!(cwd));
    params.insert("approvalPolicy".into(), json!(approval));
    params.insert("sandbox".into(), json!(sandbox));
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        params.insert("model".into(), json!(m));
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/start",
        "params": Value::Object(params),
    })
}

pub fn build_thread_resume_request(
    id: u64,
    thread_id: &str,
    cwd: &str,
    model: Option<&str>,
    mode: Option<&str>,
) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("threadId".into(), json!(thread_id));
    params.insert("cwd".into(), json!(cwd));
    params.insert("excludeTurns".into(), json!(true));
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        params.insert("model".into(), json!(m));
    }
    if let Some(md) = mode.filter(|s| CODEX_PERMISSION_MODES.contains(s)) {
        let (approval, sandbox) = mode_to_codex_thread_policy(md);
        params.insert("approvalPolicy".into(), json!(approval));
        params.insert("sandbox".into(), json!(sandbox));
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/resume",
        "params": Value::Object(params),
    })
}

/// 基于清洗后的 `ResponseItem[]` 构造跨供应商迁移用的 `thread/resume` 请求：
/// 故意省略 `modelProvider`，让 `codex app-server` 自动采用当前生效的默认供应商（如官方登录 `openai`），
/// 在不改动原 `.jsonl/.jsonl.zst` 文件与 `state_*.sqlite` 的前提下实例化新线程继续对话。
pub fn build_thread_resume_with_history_request(
    id: u64,
    thread_id: &str,
    history: Vec<Value>,
    cwd: &str,
    model: Option<&str>,
    mode: Option<&str>,
) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("threadId".into(), json!(thread_id));
    params.insert("history".into(), Value::Array(history));
    params.insert("cwd".into(), json!(cwd));
    params.insert("excludeTurns".into(), json!(true));
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        params.insert("model".into(), json!(m));
    }
    if let Some(md) = mode.filter(|s| CODEX_PERMISSION_MODES.contains(s)) {
        let (approval, sandbox) = mode_to_codex_thread_policy(md);
        params.insert("approvalPolicy".into(), json!(approval));
        params.insert("sandbox".into(), json!(sandbox));
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/resume",
        "params": Value::Object(params),
    })
}

pub fn build_thread_items_list_request(
    id: u64,
    thread_id: &str,
    cursor: Option<&str>,
    limit: u64,
) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("threadId".into(), json!(thread_id));
    params.insert("limit".into(), json!(limit));
    params.insert("sortDirection".into(), json!("asc"));
    if let Some(c) = cursor {
        params.insert("cursor".into(), json!(c));
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/items/list",
        "params": Value::Object(params),
    })
}

pub fn build_thread_set_name_request(id: u64, thread_id: &str, name: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/name/set",
        "params": {
            "threadId": thread_id,
            "name": name,
        }
    })
}

#[allow(clippy::too_many_arguments)]
pub fn build_turn_start_request(
    id: u64,
    thread_id: &str,
    message: &str,
    images: Option<&[Value]>,
    cwd: &str,
    model: Option<&str>,
    effort: Option<&str>,
    mode: &str,
) -> Value {
    let (approval, sandbox_policy) = mode_to_codex_turn_policy(mode, cwd);
    let mut params = serde_json::Map::new();
    params.insert("threadId".into(), json!(thread_id));
    params.insert("input".into(), Value::Array(build_user_input(message, images)));
    params.insert("cwd".into(), json!(cwd));
    params.insert("approvalPolicy".into(), json!(approval));
    params.insert("sandboxPolicy".into(), sandbox_policy);
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        params.insert("model".into(), json!(m));
    }
    if let Some(eff) = effort.filter(|s| !s.trim().is_empty() && *s != "off") {
        params.insert("effort".into(), json!(eff));
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "turn/start",
        "params": Value::Object(params),
    })
}

pub fn build_turn_steer_request(
    id: u64,
    thread_id: &str,
    expected_turn_id: &str,
    message: &str,
    images: Option<&[Value]>,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "turn/steer",
        "params": {
            "threadId": thread_id,
            "expectedTurnId": expected_turn_id,
            "input": build_user_input(message, images),
        }
    })
}

pub fn build_turn_interrupt_request(id: u64, thread_id: &str, turn_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "turn/interrupt",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
        }
    })
}

/// 解析 `model/list` 返回的 `result.data[]`。
pub fn parse_model_list(result: &Value) -> Vec<CodexModelEntry> {
    let Some(arr) = result.get("data").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(id) = item
            .get("id")
            .or_else(|| item.get("model"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let name = item
            .get("displayName")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string();
        let default_effort = item
            .get("defaultReasoningEffort")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let supported_efforts: Vec<String> = item
            .get("supportedReasoningEfforts")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| {
                        e.get("reasoningEffort")
                            .and_then(|v| v.as_str())
                            .or_else(|| e.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        let is_default = item
            .get("isDefault")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        out.push(CodexModelEntry {
            id: id.to_string(),
            name,
            default_effort,
            supported_efforts,
            is_default,
        });
    }
    out
}

/// Codex Token 用量快照 (来自 `thread/tokenUsage/updated` 的 `TokenUsageBreakdown`)。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CodexTokenBreakdown {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}

impl CodexTokenBreakdown {
    pub fn from_value(v: &Value) -> Self {
        let g = |camel: &str, snake: &str| {
            v.get(camel)
                .or_else(|| v.get(snake))
                .and_then(|x| x.as_u64())
                .unwrap_or(0)
        };
        Self {
            total_tokens: g("totalTokens", "total_tokens"),
            input_tokens: g("inputTokens", "input_tokens"),
            cached_input_tokens: g("cachedInputTokens", "cached_input_tokens"),
            cache_write_input_tokens: g("cacheWriteInputTokens", "cache_write_input_tokens"),
            output_tokens: g("outputTokens", "output_tokens"),
            reasoning_output_tokens: g("reasoningOutputTokens", "reasoning_output_tokens"),
        }
    }

    /// 转为统一 `MessageUsage`:
    /// OpenAI/Codex 的 `inputTokens` 已包含 `cachedInputTokens` 与 `cacheWriteInputTokens`,
    /// 因此拆出非缓存 `input` 避免在总计与缓存命中率中被重复计算。
    pub fn to_message_usage(self) -> Option<MessageUsage> {
        if self.input_tokens == 0
            && self.output_tokens == 0
            && self.cached_input_tokens == 0
            && self.cache_write_input_tokens == 0
        {
            return None;
        }
        let uncached_input = self
            .input_tokens
            .saturating_sub(self.cached_input_tokens)
            .saturating_sub(self.cache_write_input_tokens);
        Some(MessageUsage {
            input: uncached_input,
            output: self.output_tokens,
            cache_read: self.cached_input_tokens,
            cache_write: self.cache_write_input_tokens,
            cost: None,
            cost_detail: None,
        })
    }

    pub fn delta_since(self, prev: Self) -> Self {
        Self {
            total_tokens: self.total_tokens.saturating_sub(prev.total_tokens),
            input_tokens: self.input_tokens.saturating_sub(prev.input_tokens),
            cached_input_tokens: self
                .cached_input_tokens
                .saturating_sub(prev.cached_input_tokens),
            cache_write_input_tokens: self
                .cache_write_input_tokens
                .saturating_sub(prev.cache_write_input_tokens),
            output_tokens: self.output_tokens.saturating_sub(prev.output_tokens),
            reasoning_output_tokens: self
                .reasoning_output_tokens
                .saturating_sub(prev.reasoning_output_tokens),
        }
    }
}

/// 解析 `thread/tokenUsage/updated` 的 `params` → `(total, last, model_context_window)`。
pub fn parse_token_usage_update(
    params: &Value,
) -> Option<(CodexTokenBreakdown, CodexTokenBreakdown, Option<u64>)> {
    let tu = params.get("tokenUsage")?;
    let total = tu
        .get("total")
        .map(CodexTokenBreakdown::from_value)
        .unwrap_or_default();
    let last = tu
        .get("last")
        .map(CodexTokenBreakdown::from_value)
        .unwrap_or_default();
    let window = tu
        .get("modelContextWindow")
        .and_then(|v| v.as_u64())
        .filter(|w| *w > 0);
    Some((total, last, window))
}

/// 解析 `turn/plan/updated` 通知 → 统一 `PlanSnapshot`。
pub fn parse_codex_plan_update(params: &Value) -> Option<PlanSnapshot> {
    let arr = params.get("plan").and_then(|v| v.as_array())?;
    let title = params
        .get("explanation")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let items: Vec<PlanItem> = arr
        .iter()
        .enumerate()
        .filter_map(|(i, item)| {
            let content = item
                .get("step")
                .or_else(|| item.get("content"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_string();
            let status = PlanItemStatus::parse(item.get("status").and_then(|v| v.as_str()));
            Some(PlanItem {
                id: format!("codex-plan-{}", i + 1),
                content,
                active_form: None,
                status,
                priority: None,
                note: None,
                blocked_by: Vec::new(),
            })
        })
        .collect();

    Some(PlanSnapshot {
        title,
        items,
        source: "codex_plan".to_string(),
    })
}

/// Codex 反向审批请求类型 (用于回复时按协议分支构造 JSON-RPC response)。
#[derive(Debug, Clone, PartialEq)]
pub enum CodexApprovalKind {
    CommandExecution,
    FileChange,
    Permissions { requested: Value },
    LegacyExecCommand,
    LegacyApplyPatch,
}

/// 翻译 Codex 反向审批请求 → `(PermissionRequestPayload, CodexApprovalKind)`。
pub fn translate_codex_approval_request(
    method: &str,
    request_key: String,
    params: &Value,
) -> Option<(PermissionRequestPayload, CodexApprovalKind)> {
    match method {
        "item/commandExecution/requestApproval" => {
            let tool_call_id = params
                .get("itemId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let command = params
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let cwd = params.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
            let reason = params
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let mut input_obj = serde_json::Map::new();
            if !command.is_empty() {
                input_obj.insert("command".into(), json!(command));
            }
            if !cwd.is_empty() {
                input_obj.insert("cwd".into(), json!(cwd));
            }
            if let Some(actions) = params.get("commandActions") {
                if actions.as_array().is_some_and(|a| !a.is_empty()) {
                    input_obj.insert("commandActions".into(), actions.clone());
                }
            }
            let payload = PermissionRequestPayload {
                id: request_key,
                tool_name: "bash".to_string(),
                tool_call_id,
                description: reason,
                input: Value::Object(input_obj),
                options: vec![
                    PermissionOption {
                        id: "accept".into(),
                        label: "允许本次".into(),
                        kind: "allow_once".into(),
                    },
                    PermissionOption {
                        id: "acceptForSession".into(),
                        label: "本会话总是允许".into(),
                        kind: "allow_always".into(),
                    },
                    PermissionOption {
                        id: "decline".into(),
                        label: "拒绝".into(),
                        kind: "reject_once".into(),
                    },
                ],
            };
            Some((payload, CodexApprovalKind::CommandExecution))
        }
        "item/fileChange/requestApproval" => {
            let tool_call_id = params
                .get("itemId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let reason = params
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| Some("请求修改文件".to_string()));
            let input = json!({
                "grantRoot": params.get("grantRoot").cloned().unwrap_or(Value::Null),
                "itemId": params.get("itemId").cloned().unwrap_or(Value::Null),
            });
            let payload = PermissionRequestPayload {
                id: request_key,
                tool_name: "apply_patch".to_string(),
                tool_call_id,
                description: reason,
                input,
                options: vec![
                    PermissionOption {
                        id: "accept".into(),
                        label: "允许本次".into(),
                        kind: "allow_once".into(),
                    },
                    PermissionOption {
                        id: "acceptForSession".into(),
                        label: "本会话总是允许".into(),
                        kind: "allow_always".into(),
                    },
                    PermissionOption {
                        id: "decline".into(),
                        label: "拒绝".into(),
                        kind: "reject_once".into(),
                    },
                ],
            };
            Some((payload, CodexApprovalKind::FileChange))
        }
        "item/permissions/requestApproval" => {
            let tool_call_id = params
                .get("itemId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let reason = params
                .get("reason")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| Some("请求扩展沙箱权限".to_string()));
            let requested = params
                .get("permissions")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let payload = PermissionRequestPayload {
                id: request_key,
                tool_name: "permissions".to_string(),
                tool_call_id,
                description: reason,
                input: requested.clone(),
                options: vec![
                    PermissionOption {
                        id: "turn".into(),
                        label: "本轮授予".into(),
                        kind: "allow_once".into(),
                    },
                    PermissionOption {
                        id: "session".into(),
                        label: "本会话授予".into(),
                        kind: "allow_always".into(),
                    },
                    PermissionOption {
                        id: "deny".into(),
                        label: "拒绝".into(),
                        kind: "reject_once".into(),
                    },
                ],
            };
            Some((payload, CodexApprovalKind::Permissions { requested }))
        }
        "execCommandApproval" => {
            let tool_call_id = params
                .get("callId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let reason = params
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let payload = PermissionRequestPayload {
                id: request_key,
                tool_name: "bash".to_string(),
                tool_call_id,
                description: reason,
                input: json!({
                    "command": params.get("command").cloned().unwrap_or(Value::Null),
                    "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                }),
                options: vec![
                    PermissionOption {
                        id: "approved".into(),
                        label: "允许本次".into(),
                        kind: "allow_once".into(),
                    },
                    PermissionOption {
                        id: "approved_for_session".into(),
                        label: "本会话总是允许".into(),
                        kind: "allow_always".into(),
                    },
                    PermissionOption {
                        id: "denied".into(),
                        label: "拒绝".into(),
                        kind: "reject_once".into(),
                    },
                ],
            };
            Some((payload, CodexApprovalKind::LegacyExecCommand))
        }
        "applyPatchApproval" => {
            let tool_call_id = params
                .get("callId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let reason = params
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let payload = PermissionRequestPayload {
                id: request_key,
                tool_name: "apply_patch".to_string(),
                tool_call_id,
                description: reason,
                input: params
                    .get("fileChanges")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                options: vec![
                    PermissionOption {
                        id: "approved".into(),
                        label: "允许本次".into(),
                        kind: "allow_once".into(),
                    },
                    PermissionOption {
                        id: "approved_for_session".into(),
                        label: "本会话总是允许".into(),
                        kind: "allow_always".into(),
                    },
                    PermissionOption {
                        id: "denied".into(),
                        label: "拒绝".into(),
                        kind: "reject_once".into(),
                    },
                ],
            };
            Some((payload, CodexApprovalKind::LegacyApplyPatch))
        }
        _ => None,
    }
}

/// 构造 Codex 反向审批请求的 JSON-RPC 2.0 响应帧。
pub fn build_codex_approval_response(
    rpc_id: Value,
    kind: &CodexApprovalKind,
    allow: bool,
    option_id: Option<&str>,
) -> Value {
    let result = match kind {
        CodexApprovalKind::CommandExecution | CodexApprovalKind::FileChange => {
            let decision = if !allow {
                "decline"
            } else {
                match option_id {
                    Some("acceptForSession") => "acceptForSession",
                    Some("decline") => "decline",
                    Some("cancel") => "cancel",
                    _ => "accept",
                }
            };
            json!({ "decision": decision })
        }
        CodexApprovalKind::Permissions { requested } => {
            if !allow || option_id == Some("deny") {
                json!({ "permissions": {}, "scope": "turn" })
            } else {
                let scope = if option_id == Some("session") {
                    "session"
                } else {
                    "turn"
                };
                json!({ "permissions": requested, "scope": scope })
            }
        }
        CodexApprovalKind::LegacyExecCommand | CodexApprovalKind::LegacyApplyPatch => {
            let decision = if !allow {
                "denied"
            } else if option_id == Some("approved_for_session") {
                "approved_for_session"
            } else {
                "approved"
            };
            json!({ "decision": decision })
        }
    };
    json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": result,
    })
}

/// 翻译 Codex `item/tool/requestUserInput` 反向请求 → 统一 `UserPromptRequest`。
pub fn translate_codex_user_input_request(
    request_key: String,
    params: &Value,
) -> Option<UserPromptRequest> {
    let arr = params.get("questions").and_then(|v| v.as_array())?;
    let mut questions = Vec::with_capacity(arr.len());
    for (idx, q) in arr.iter().enumerate() {
        let prompt_text = q
            .get("question")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())?
            .to_string();
        let id = q
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("q{}", idx + 1));
        let header = q
            .get("header")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let options: Vec<PromptOption> = q
            .get("options")
            .and_then(|v| v.as_array())
            .map(|opts| {
                opts.iter()
                    .filter_map(|o| {
                        let label = o
                            .get("label")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())?
                            .to_string();
                        let description = o
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());
                        let recommended = label.contains("(Recommended)") || label.contains("（推荐）");
                        Some(PromptOption {
                            id: label.clone(),
                            label,
                            description,
                            recommended,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let is_other = q.get("isOther").and_then(|v| v.as_bool()).unwrap_or(true);
        let allow_custom = is_other || options.is_empty();
        questions.push(PromptQuestion {
            id,
            header,
            prompt: prompt_text,
            multi_select: false,
            options,
            allow_custom,
        });
    }
    if questions.is_empty() {
        return None;
    }

    Some(UserPromptRequest {
        id: request_key,
        kind: UserPromptKind::Questions,
        title: Some("Codex 需要你的决定".to_string()),
        description: None,
        questions,
        placeholder: None,
        prefill: None,
        allow_cancel: true,
        source_tool: Some("codex_request_user_input".to_string()),
    })
}

/// 构造 `item/tool/requestUserInput` 的 JSON-RPC 2.0 响应帧。
pub fn build_codex_user_input_response(rpc_id: Value, response: UserPromptResponse) -> Value {
    let mut answer_map = serde_json::Map::new();
    if let UserPromptResponse::Submit { answers, text, .. } = response {
        for (q_id, vals) in answers {
            let cleaned: Vec<String> = vals
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !cleaned.is_empty() {
                answer_map.insert(q_id, json!({ "answers": cleaned }));
            }
        }
        if answer_map.is_empty() {
            if let Some(t) = text.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                answer_map.insert("q1".into(), json!({ "answers": [t] }));
            }
        }
    }
    json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": {
            "answers": Value::Object(answer_map),
        }
    })
}

/// 将单个 Codex `ThreadItem` 拆解为 `(tool_call_id, tool_name, args)` (若是工具类条目)。
pub fn extract_tool_start_from_item(item: &Value) -> Option<(String, String, Value)> {
    let item_type = item.get("type").and_then(|v| v.as_str())?;
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())?
        .to_string();

    match item_type {
        "commandExecution" => {
            let command = item
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let cwd = item.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
            Some((
                id,
                "bash".to_string(),
                json!({ "command": command, "cwd": cwd }),
            ))
        }
        "fileChange" => {
            let changes = item
                .get("changes")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let first_path = changes
                .first()
                .and_then(|c| c.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let paths: Vec<String> = changes
                .iter()
                .filter_map(|c| c.get("path").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();
            Some((
                id,
                "apply_patch".to_string(),
                json!({ "path": first_path, "files": paths }),
            ))
        }
        "mcpToolCall" => {
            let server = item.get("server").and_then(|v| v.as_str()).unwrap_or("mcp");
            let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            let args = item.get("arguments").cloned().unwrap_or(Value::Null);
            Some((id, format!("{server}:{tool}"), args))
        }
        "dynamicToolCall" => {
            let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            let args = item.get("arguments").cloned().unwrap_or(Value::Null);
            Some((id, tool.to_string(), args))
        }
        "webSearch" => {
            let query = item.get("query").and_then(|v| v.as_str()).unwrap_or("");
            Some((id, "web_search".to_string(), json!({ "query": query })))
        }
        "imageView" => {
            let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
            Some((id, "image_view".to_string(), json!({ "path": path })))
        }
        "imageGeneration" => {
            let prompt = item
                .get("revisedPrompt")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Some((
                id,
                "image_generation".to_string(),
                json!({ "prompt": prompt }),
            ))
        }
        "collabAgentToolCall" => {
            let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("subagent");
            let prompt = item.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            Some((
                id,
                format!("collab:{tool}"),
                json!({ "task": prompt, "model": item.get("model").cloned().unwrap_or(Value::Null) }),
            ))
        }
        _ => None,
    }
}

/// 从已完成的工具类 `ThreadItem` 提取 `(is_error, normalized_result)` (对齐 `StepDetail` 展示结构)。
pub fn extract_tool_end_from_item(item: &Value) -> Option<(String, bool, Value)> {
    let item_type = item.get("type").and_then(|v| v.as_str())?;
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())?
        .to_string();

    match item_type {
        "commandExecution" => {
            let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let exit_code = item.get("exitCode").and_then(|v| v.as_i64());
            let is_error = matches!(status, "failed" | "declined")
                || exit_code.is_some_and(|c| c != 0);
            let output = item
                .get("aggregatedOutput")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut text = output.to_string();
            if let Some(code) = exit_code {
                if code != 0 {
                    if !text.is_empty() && !text.ends_with('\n') {
                        text.push('\n');
                    }
                    text.push_str(&format!("[exit code: {code}]"));
                }
            }
            Some((id, is_error, json!({ "content": [{ "type": "text", "text": text }] })))
        }
        "fileChange" => {
            let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let is_error = matches!(status, "failed" | "declined");
            let mut parts = Vec::new();
            let mut diffs = Vec::new();
            if let Some(changes) = item.get("changes").and_then(|v| v.as_array()) {
                for ch in changes {
                    let path = ch.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let kind = ch
                        .get("kind")
                        .and_then(|k| k.get("type"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("update");
                    let diff = ch.get("diff").and_then(|v| v.as_str()).unwrap_or("");
                    if !diff.is_empty() {
                        parts.push(format!("=== {kind}: {path} ===\n{diff}"));
                        diffs.push(diff);
                    } else if !path.is_empty() {
                        parts.push(format!("{kind}: {path}"));
                    }
                }
            }
            let text = parts.join("\n\n");
            let combined_diff = diffs.join("\n");
            let result = if !combined_diff.is_empty() {
                json!({
                    "content": [{ "type": "text", "text": text }],
                    "details": { "diff": combined_diff }
                })
            } else {
                json!({ "content": [{ "type": "text", "text": text }] })
            };
            Some((id, is_error, result))
        }
        "mcpToolCall" => {
            let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let err_msg = item
                .get("error")
                .and_then(|e| e.get("message").and_then(|v| v.as_str()).or_else(|| e.as_str()));
            let is_error = status == "failed" || err_msg.is_some();
            if let Some(msg) = err_msg {
                return Some((
                    id,
                    true,
                    json!({ "content": [{ "type": "text", "text": msg }] }),
                ));
            }
            if let Some(content) = item
                .get("result")
                .and_then(|r| r.get("content"))
                .and_then(|v| v.as_array())
            {
                return Some((id, is_error, json!({ "content": content })));
            }
            let fallback = item
                .get("result")
                .filter(|v| !v.is_null())
                .map(|v| v.to_string())
                .unwrap_or_default();
            Some((id, is_error, json!({ "content": [{ "type": "text", "text": fallback }] })))
        }
        "dynamicToolCall" => {
            let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let success = item.get("success").and_then(|v| v.as_bool());
            let is_error = status == "failed" || success == Some(false);
            let mut texts = Vec::new();
            if let Some(items) = item.get("contentItems").and_then(|v| v.as_array()) {
                for ci in items {
                    if let Some(t) = ci.get("text").and_then(|v| v.as_str()) {
                        texts.push(json!({ "type": "text", "text": t }));
                    }
                }
            }
            Some((id, is_error, json!({ "content": texts })))
        }
        "webSearch" => {
            let query = item.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let action_txt = item
                .get("action")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                .unwrap_or_else(|| query.to_string());
            Some((
                id,
                false,
                json!({ "content": [{ "type": "text", "text": action_txt }] }),
            ))
        }
        "imageView" => {
            let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
            Some((id, false, json!({ "content": [{ "type": "text", "text": path }] })))
        }
        "imageGeneration" => {
            let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let is_error = status == "failed";
            let result = item
                .get("result")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("revisedPrompt").and_then(|v| v.as_str()))
                .unwrap_or("");
            Some((id, is_error, json!({ "content": [{ "type": "text", "text": result }] })))
        }
        "collabAgentToolCall" => {
            let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let is_error = status == "failed";
            let summary = item
                .get("agentsStates")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                .unwrap_or_default();
            Some((id, is_error, json!({ "content": [{ "type": "text", "text": summary }] })))
        }
        _ => None,
    }
}

/// 有状态 Codex App Server 流式翻译器: 将 `ServerNotification` 帧转为 `Vec<UnifiedEvent>`。
#[derive(Debug, Default)]
pub struct CodexStreamTranslator {
    turn_active: bool,
    assistant_open: bool,
    assistant_has_content: bool,
    streamed_text_items: HashSet<String>,
    streamed_reasoning_items: HashSet<String>,
    started_tools: HashSet<String>,
    tool_output_buffers: HashMap<String, String>,
    reasoning_parts_seen: HashMap<String, usize>,
    last_total_usage: CodexTokenBreakdown,
    turn_start_usage: CodexTokenBreakdown,
    turn_saw_usage: bool,
}

impl CodexStreamTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    /// `send_prompt` 已向前端先发 `TurnStart` + `AssistantStart` 占位时同步状态, 防重发。
    pub fn mark_prompt_dispatched(&mut self) {
        self.turn_active = true;
        self.assistant_open = true;
        self.assistant_has_content = false;
        self.streamed_text_items.clear();
        self.streamed_reasoning_items.clear();
        self.started_tools.clear();
        self.tool_output_buffers.clear();
        self.reasoning_parts_seen.clear();
        self.turn_start_usage = self.last_total_usage;
        self.turn_saw_usage = false;
    }

    fn ensure_assistant_open(&mut self, item_id: Option<String>, out: &mut Vec<UnifiedEvent>) {
        if !self.assistant_open {
            self.assistant_open = true;
            self.assistant_has_content = false;
            out.push(UnifiedEvent::AssistantStart {
                message_id: item_id,
            });
        }
    }

    fn close_assistant_if_content(&mut self, out: &mut Vec<UnifiedEvent>) {
        if self.assistant_open && self.assistant_has_content {
            self.assistant_open = false;
            self.assistant_has_content = false;
            out.push(UnifiedEvent::AssistantEnd {
                usage: None,
                stop_reason: None,
                error_message: None,
            });
        }
    }

    pub fn translate_notification(&mut self, method: &str, params: &Value) -> Vec<UnifiedEvent> {
        let mut out = Vec::new();
        match method {
            "turn/started" => {
                if !self.turn_active {
                    self.mark_prompt_dispatched();
                    out.push(UnifiedEvent::TurnStart);
                    out.push(UnifiedEvent::AssistantStart { message_id: None });
                }
            }
            "item/agentMessage/delta" => {
                let item_id = params
                    .get("itemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                if !delta.is_empty() {
                    if !item_id.is_empty() {
                        self.streamed_text_items.insert(item_id.clone());
                    }
                    self.ensure_assistant_open(
                        (!item_id.is_empty()).then_some(item_id),
                        &mut out,
                    );
                    self.assistant_has_content = true;
                    out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Text,
                    });
                    out.push(UnifiedEvent::TextDelta {
                        delta: delta.to_string(),
                    });
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                let item_id = params
                    .get("itemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                if !delta.is_empty() {
                    if !item_id.is_empty() {
                        self.streamed_reasoning_items.insert(item_id.clone());
                    }
                    self.ensure_assistant_open(
                        (!item_id.is_empty()).then_some(item_id),
                        &mut out,
                    );
                    self.assistant_has_content = true;
                    out.push(UnifiedEvent::ContentBlockStart {
                        block: ContentBlockKind::Thinking,
                    });
                    out.push(UnifiedEvent::ThinkingDelta {
                        delta: delta.to_string(),
                    });
                }
            }
            "item/reasoning/summaryPartAdded" => {
                let item_id = params
                    .get("itemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !item_id.is_empty() {
                    let count = self.reasoning_parts_seen.entry(item_id.clone()).or_insert(0);
                    *count += 1;
                    if *count > 1 && self.streamed_reasoning_items.contains(&item_id) {
                        self.ensure_assistant_open(Some(item_id), &mut out);
                        out.push(UnifiedEvent::ThinkingDelta {
                            delta: "\n\n".to_string(),
                        });
                    }
                }
            }
            "item/started" => {
                let Some(item) = params.get("item") else {
                    return out;
                };
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match item_type {
                    "agentMessage" | "reasoning" => {
                        let id = item
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        self.ensure_assistant_open(id, &mut out);
                    }
                    _ => {
                        if let Some((tc_id, tc_name, args)) = extract_tool_start_from_item(item) {
                            // 正文/思考与工具步骤分段: 结束之前的正文气泡, 让后续回复落到步骤卡下方
                            self.close_assistant_if_content(&mut out);
                            if self.started_tools.insert(tc_id.clone()) {
                                out.push(UnifiedEvent::ToolStart {
                                    tool_call_id: tc_id,
                                    tool_name: tc_name,
                                    args,
                                });
                            }
                        }
                    }
                }
            }
            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                let item_id = params
                    .get("itemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                if !item_id.is_empty() && !delta.is_empty() {
                    let buf = self.tool_output_buffers.entry(item_id.clone()).or_default();
                    buf.push_str(delta);
                    out.push(UnifiedEvent::ToolUpdate {
                        tool_call_id: item_id,
                        partial_result: json!({
                            "content": [{ "type": "text", "text": buf.clone() }]
                        }),
                    });
                }
            }
            "item/mcpToolCall/progress" => {
                let item_id = params
                    .get("itemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let msg = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
                if !item_id.is_empty() && !msg.is_empty() {
                    let buf = self.tool_output_buffers.entry(item_id.clone()).or_default();
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(msg);
                    out.push(UnifiedEvent::ToolUpdate {
                        tool_call_id: item_id,
                        partial_result: json!({
                            "content": [{ "type": "text", "text": buf.clone() }]
                        }),
                    });
                }
            }
            "item/completed" => {
                let Some(item) = params.get("item") else {
                    return out;
                };
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                match item_type {
                    "agentMessage" => {
                        if !self.streamed_text_items.contains(&item_id) {
                            if let Some(text) = item
                                .get("text")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                            {
                                self.ensure_assistant_open(
                                    (!item_id.is_empty()).then_some(item_id.clone()),
                                    &mut out,
                                );
                                self.assistant_has_content = true;
                                out.push(UnifiedEvent::ContentBlockStart {
                                    block: ContentBlockKind::Text,
                                });
                                out.push(UnifiedEvent::TextDelta {
                                    delta: text.to_string(),
                                });
                            }
                        }
                        self.close_assistant_if_content(&mut out);
                    }
                    "reasoning" => {
                        if !self.streamed_reasoning_items.contains(&item_id) {
                            let joined = extract_reasoning_text(item);
                            if !joined.is_empty() {
                                self.ensure_assistant_open(
                                    (!item_id.is_empty()).then_some(item_id.clone()),
                                    &mut out,
                                );
                                self.assistant_has_content = true;
                                out.push(UnifiedEvent::ContentBlockStart {
                                    block: ContentBlockKind::Thinking,
                                });
                                out.push(UnifiedEvent::ThinkingDelta { delta: joined });
                            }
                        }
                    }
                    "contextCompaction" => {
                        out.push(UnifiedEvent::Notice {
                            id: None,
                            notify_type: NotifyLevel::Info,
                            message: "Codex 已自动压缩上下文".to_string(),
                            from_extension: false,
                        });
                    }
                    _ => {
                        if let Some((tc_id, is_error, result)) = extract_tool_end_from_item(item) {
                            self.tool_output_buffers.remove(&tc_id);
                            if !self.started_tools.contains(&tc_id) {
                                if let Some((_, tc_name, args)) = extract_tool_start_from_item(item)
                                {
                                    self.close_assistant_if_content(&mut out);
                                    self.started_tools.insert(tc_id.clone());
                                    out.push(UnifiedEvent::ToolStart {
                                        tool_call_id: tc_id.clone(),
                                        tool_name: tc_name,
                                        args,
                                    });
                                }
                            }
                            out.push(UnifiedEvent::ToolEnd {
                                tool_call_id: tc_id,
                                is_error,
                                result,
                            });
                        }
                    }
                }
            }
            "turn/plan/updated" => {
                if let Some(plan) = parse_codex_plan_update(params) {
                    out.push(UnifiedEvent::PlanUpdate { plan });
                }
            }
            "thread/tokenUsage/updated" => {
                if let Some((total, last, _)) = parse_token_usage_update(params) {
                    self.last_total_usage = total;
                    self.turn_saw_usage = true;
                    let uncached_in = last
                        .input_tokens
                        .saturating_sub(last.cached_input_tokens)
                        .saturating_sub(last.cache_write_input_tokens);
                    out.push(UnifiedEvent::LiveUsage {
                        input: uncached_in + last.cached_input_tokens + last.cache_write_input_tokens,
                        output: last.output_tokens,
                    });
                }
            }
            "turn/completed" => {
                let turn = params.get("turn");
                let status = turn
                    .and_then(|t| t.get("status"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let error_message = turn
                    .and_then(|t| t.get("error"))
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let turn_usage = if self.turn_saw_usage {
                    self.last_total_usage
                        .delta_since(self.turn_start_usage)
                        .to_message_usage()
                } else {
                    None
                };

                if self.assistant_open || turn_usage.is_some() || error_message.is_some() {
                    out.push(UnifiedEvent::AssistantEnd {
                        usage: turn_usage,
                        stop_reason: status,
                        error_message,
                    });
                }
                self.assistant_open = false;
                self.assistant_has_content = false;
                self.turn_active = false;
                self.tool_output_buffers.clear();
                out.push(UnifiedEvent::TurnSettled);
            }
            "error" => {
                let will_retry = params
                    .get("willRetry")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let msg = params
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Codex 执行出错")
                    .to_string();
                if will_retry {
                    out.push(UnifiedEvent::Notice {
                        id: None,
                        notify_type: NotifyLevel::Warning,
                        message: format!("Codex 请求波动，正在重试: {msg}"),
                        from_extension: false,
                    });
                } else {
                    out.push(UnifiedEvent::Notice {
                        id: None,
                        notify_type: NotifyLevel::Error,
                        message: msg,
                        from_extension: false,
                    });
                }
            }
            "warning" => {
                if let Some(msg) = params.get("message").and_then(|v| v.as_str()) {
                    if !msg.trim().is_empty() {
                        out.push(UnifiedEvent::Notice {
                            id: None,
                            notify_type: NotifyLevel::Warning,
                            message: msg.trim().to_string(),
                            from_extension: false,
                        });
                    }
                }
            }
            _ => {}
        }
        out
    }
}

fn extract_reasoning_text(item: &Value) -> String {
    let mut parts = Vec::new();
    for key in ["summary", "content"] {
        if let Some(arr) = item.get(key).and_then(|v| v.as_array()) {
            for s in arr {
                if let Some(t) = s.as_str().map(str::trim).filter(|t| !t.is_empty()) {
                    parts.push(t.to_string());
                }
            }
        }
        if !parts.is_empty() {
            break;
        }
    }
    parts.join("\n\n")
}

/// 将 Codex `ThreadItem` 列表 (来自 `thread_history_*.sqlite` 或 `thread/items/list`)
/// 转为前端 `mapHistoryEntries` 100% 兼容的标准历史条目数组。
pub fn thread_items_to_entries(items: &[(Value, Option<String>)]) -> Vec<Value> {
    let mut entries = Vec::new();
    let mut pending_thinking = String::new();

    let flush_thinking = |pending: &mut String, entries: &mut Vec<Value>, id: &str, ts: &str| {
        let th = std::mem::take(pending);
        if !th.is_empty() {
            entries.push(json!({
                "type": "message",
                "id": format!("codex-th-{id}"),
                "timestamp": ts,
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "thinking", "thinking": th }],
                }
            }));
        }
    };

    for (idx, (item, ts_opt)) in items.iter().enumerate() {
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let item_id = item
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("item-{idx}"));
        let ts = ts_opt.as_deref().unwrap_or("");

        match item_type {
            "userMessage" => {
                flush_thinking(&mut pending_thinking, &mut entries, &item_id, ts);
                let text = item
                    .get("content")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|c| {
                                if c.get("type").and_then(|v| v.as_str()) == Some("text") {
                                    c.get("text").and_then(|v| v.as_str())
                                } else {
                                    None
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    entries.push(json!({
                        "type": "message",
                        "id": item_id,
                        "timestamp": ts,
                        "message": {
                            "role": "user",
                            "content": [{ "type": "text", "text": text }],
                        }
                    }));
                }
            }
            "reasoning" => {
                let th = extract_reasoning_text(item);
                if !th.is_empty() {
                    if !pending_thinking.is_empty() {
                        pending_thinking.push_str("\n\n");
                    }
                    pending_thinking.push_str(&th);
                }
            }
            "agentMessage" => {
                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let mut blocks = Vec::new();
                let th = std::mem::take(&mut pending_thinking);
                if !th.is_empty() {
                    blocks.push(json!({ "type": "thinking", "thinking": th }));
                }
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                if !blocks.is_empty() {
                    entries.push(json!({
                        "type": "message",
                        "id": item_id,
                        "timestamp": ts,
                        "message": {
                            "role": "assistant",
                            "content": blocks,
                        }
                    }));
                }
            }
            _ => {
                if let Some((tc_id, tc_name, args)) = extract_tool_start_from_item(item) {
                    let mut blocks = Vec::new();
                    let th = std::mem::take(&mut pending_thinking);
                    if !th.is_empty() {
                        blocks.push(json!({ "type": "thinking", "thinking": th }));
                    }
                    blocks.push(json!({
                        "type": "toolCall",
                        "id": tc_id,
                        "name": tc_name,
                        "arguments": args,
                    }));
                    entries.push(json!({
                        "type": "message",
                        "id": format!("codex-tc-{item_id}"),
                        "timestamp": ts,
                        "message": {
                            "role": "assistant",
                            "content": blocks,
                        }
                    }));
                    if let Some((res_id, is_error, result)) = extract_tool_end_from_item(item) {
                        let mut msg_obj = serde_json::Map::new();
                        msg_obj.insert("role".into(), json!("toolResult"));
                        msg_obj.insert("toolCallId".into(), json!(res_id));
                        msg_obj.insert("isError".into(), json!(is_error));
                        msg_obj.insert(
                            "content".into(),
                            result.get("content").cloned().unwrap_or_else(|| json!([])),
                        );
                        if let Some(details) = result.get("details") {
                            msg_obj.insert("details".into(), details.clone());
                        }
                        entries.push(json!({
                            "type": "message",
                            "id": format!("codex-tr-{item_id}"),
                            "timestamp": ts,
                            "message": Value::Object(msg_obj),
                        }));
                    }
                }
            }
        }
    }

    flush_thinking(&mut pending_thinking, &mut entries, "tail", "");
    entries
}

/// 从英文提示文本中提取被弯引号 / 直引号 / 反引号包裹的 provider 名称（兜底用）。
fn extract_quoted_provider(msg: &str) -> Option<String> {
    let pairs = [('\u{201C}', '\u{201D}'), ('"', '"'), ('\'', '\''), ('`', '`')];
    for (open, close) in pairs {
        if let Some(start) = msg.find(open) {
            let after = &msg[start + open.len_utf8()..];
            if let Some(end) = after.find(close) {
                let candidate = after[..end].trim();
                if !candidate.is_empty() && candidate.len() <= 64 {
                    return Some(candidate.to_string());
                }
            }
        }
    }
    None
}

/// 检测 JSON-RPC `error` 是否属于原模型供应商未配置 (`modelProviderNotConfigured`)，
/// 命中时返回缺失的 provider 名称（优先取结构化 `data.modelProvider`，兜底从 `message` 引号提取）。
pub fn extract_missing_model_provider(err: &Value) -> Option<Option<String>> {
    let msg = err
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let data = err.get("data");
    let err_type = data
        .and_then(|d| d.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let lower_msg = msg.map(|s| s.to_ascii_lowercase()).unwrap_or_default();

    if err_type != "modelProviderNotConfigured"
        && !(lower_msg.contains("model provider") && lower_msg.contains("no longer configured"))
    {
        return None;
    }

    let provider = data
        .and_then(|d| d.get("modelProvider"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| msg.and_then(extract_quoted_provider));
    Some(provider)
}

/// 清洗单条 rollout `response_item.payload` 以便跨供应商无损迁移：
/// 第三方/旧账号生成的加密块（`encrypted_content` / `encrypted_function_args` / `compaction`）
/// 无法被新供应商服务端解密（会触发 HTTP 400 `invalid_encrypted_content`），必须递归剥离，
/// 同时完整保留对话文本、工具调用与输出（保持 `call_id` 配对）以及可读思考摘要。
pub fn sanitize_response_item_for_migration(item: &Value) -> Option<Value> {
    let obj = item.as_object()?;
    let item_type = obj.get("type").and_then(|v| v.as_str())?;

    // 丢弃旧供应商加密压缩块与未知占位项
    if matches!(
        item_type,
        "compaction" | "compaction_summary" | "context_compaction" | "compaction_trigger" | "other"
    ) {
        return None;
    }

    let mut cleaned = obj.clone();

    // 清空所有顶层加密字段（覆盖 reasoning / message / function_call / local_shell_call /
    // custom_tool_call / tool_search_call / web_search_call / image_generation_call 等全部变体）
    if cleaned.contains_key("encrypted_content") {
        cleaned.insert("encrypted_content".into(), Value::Null);
    }
    if cleaned.contains_key("encrypted_function_args") {
        cleaned.insert("encrypted_function_args".into(), Value::Null);
    }

    // 过滤嵌套数组中的 `{"type": "encrypted_content", ...}` 子项 (agent_message.content / *_output.output)
    for arr_key in ["content", "output"] {
        if let Some(Value::Array(arr)) = cleaned.get(arr_key).cloned() {
            let filtered: Vec<Value> = arr
                .into_iter()
                .filter(|el| {
                    el.get("type").and_then(|t| t.as_str()) != Some("encrypted_content")
                })
                .collect();
            if filtered.is_empty() {
                if matches!(item_type, "message" | "agent_message") {
                    return None;
                }
                if matches!(item_type, "function_call_output" | "custom_tool_call_output") {
                    // 保留空输出字符串，防止前序 tool_call 失去 call_id 配对导致 API 报 400
                    cleaned.insert(arr_key.into(), Value::String(String::new()));
                    continue;
                }
            }
            cleaned.insert(arr_key.into(), Value::Array(filtered));
        }
    }

    // 剥离加密思考块后，若既无 summary 也无明文 content 则整条丢弃
    if item_type == "reasoning" {
        let has_summary = cleaned
            .get("summary")
            .and_then(|v| v.as_array())
            .is_some_and(|a| !a.is_empty());
        let has_content = cleaned
            .get("content")
            .and_then(|v| v.as_array())
            .is_some_and(|a| !a.is_empty());
        if !has_summary && !has_content {
            return None;
        }
    }

    Some(Value::Object(cleaned))
}

/// 判断 rollout `user` message 是否属于 Codex 内部注入的环境/规则上下文块（非真实用户输入）。
fn is_codex_injected_user_context(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("# AGENTS.md instructions for ")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("<permissions instructions>")
        || trimmed.starts_with("<collaboration_mode>")
        || trimmed.starts_with("<turn_aborted>")
}

/// 将 rollout 中的原始 `response_item` 列表转为标准前端历史条目（当 `thread_history_*.sqlite`
/// 与 `event_msg(item_completed)` 均为空时的兜底回放，如刚跨供应商迁移生成的线程再次打开）。
pub fn response_items_to_entries(items: &[(Value, Option<String>)]) -> Vec<Value> {
    let mut entries: Vec<Value> = Vec::new();
    let mut pending_thinking: Vec<String> = Vec::new();

    for (idx, (item, ts_opt)) in items.iter().enumerate() {
        let ts = ts_opt.as_deref().unwrap_or("");
        let Some(kind) = item.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        let item_id = item
            .get("id")
            .or_else(|| item.get("call_id"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("ri-{idx}"));

        match kind {
            "reasoning" => {
                let mut parts: Vec<String> = Vec::new();
                if let Some(arr) = item.get("summary").and_then(|v| v.as_array()) {
                    for s in arr {
                        if let Some(t) = s.get("text").and_then(|v| v.as_str()) {
                            if !t.trim().is_empty() {
                                parts.push(t.to_string());
                            }
                        }
                    }
                }
                if parts.is_empty() {
                    if let Some(arr) = item.get("content").and_then(|v| v.as_array()) {
                        for c in arr {
                            if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                                if !t.trim().is_empty() {
                                    parts.push(t.to_string());
                                }
                            }
                        }
                    }
                }
                let joined = parts.join("\n\n");
                if !joined.trim().is_empty() {
                    pending_thinking.push(joined);
                }
            }
            "message" => {
                let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role != "user" && role != "assistant" {
                    continue;
                }
                let mut texts: Vec<String> = Vec::new();
                if let Some(arr) = item.get("content").and_then(|v| v.as_array()) {
                    for c in arr {
                        if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                            if role == "user" && is_codex_injected_user_context(t) {
                                continue;
                            }
                            if !t.trim().is_empty() {
                                texts.push(t.to_string());
                            }
                        }
                    }
                }
                if texts.is_empty() {
                    continue;
                }
                if role == "user" {
                    if !pending_thinking.is_empty() {
                        let thinking = std::mem::take(&mut pending_thinking).join("\n\n");
                        entries.push(json!({
                            "type": "message",
                            "id": format!("codex-ri-think-{idx}"),
                            "timestamp": ts,
                            "message": {
                                "role": "assistant",
                                "content": [{ "type": "thinking", "thinking": thinking }],
                            }
                        }));
                    }
                    let blocks: Vec<Value> = texts
                        .into_iter()
                        .map(|t| json!({ "type": "text", "text": t }))
                        .collect();
                    entries.push(json!({
                        "type": "message",
                        "id": format!("codex-ri-u-{item_id}-{idx}"),
                        "timestamp": ts,
                        "message": {
                            "role": "user",
                            "content": blocks,
                        }
                    }));
                } else {
                    let mut blocks: Vec<Value> = Vec::new();
                    if !pending_thinking.is_empty() {
                        let thinking = std::mem::take(&mut pending_thinking).join("\n\n");
                        blocks.push(json!({ "type": "thinking", "thinking": thinking }));
                    }
                    blocks.push(json!({ "type": "text", "text": texts.join("\n\n") }));
                    entries.push(json!({
                        "type": "message",
                        "id": format!("codex-ri-a-{item_id}-{idx}"),
                        "timestamp": ts,
                        "message": {
                            "role": "assistant",
                            "content": blocks,
                        }
                    }));
                }
            }
            "function_call" | "custom_tool_call" | "local_shell_call" => {
                let call_id = item
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&item_id);
                let tool_name = if kind == "local_shell_call" {
                    "bash"
                } else {
                    item.get("name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or(kind)
                };
                let args = if kind == "function_call" {
                    item.get("arguments")
                        .and_then(|v| v.as_str())
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .unwrap_or_else(|| json!({ "raw": item.get("arguments").cloned().unwrap_or(Value::Null) }))
                } else if kind == "custom_tool_call" {
                    json!({ "input": item.get("input").cloned().unwrap_or(Value::Null) })
                } else {
                    item.get("action").cloned().unwrap_or_else(|| json!({}))
                };
                let mut blocks: Vec<Value> = Vec::new();
                if !pending_thinking.is_empty() {
                    let thinking = std::mem::take(&mut pending_thinking).join("\n\n");
                    blocks.push(json!({ "type": "thinking", "thinking": thinking }));
                }
                blocks.push(json!({
                    "type": "toolCall",
                    "id": call_id,
                    "name": tool_name,
                    "arguments": args,
                }));
                entries.push(json!({
                    "type": "message",
                    "id": format!("codex-ri-tc-{call_id}-{idx}"),
                    "timestamp": ts,
                    "message": {
                        "role": "assistant",
                        "content": blocks,
                    }
                }));
            }
            "function_call_output" | "custom_tool_call_output" => {
                let Some(call_id) = item
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let text = match item.get("output") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(arr)) => arr
                        .iter()
                        .filter_map(|el| el.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                entries.push(json!({
                    "type": "message",
                    "id": format!("codex-ri-tr-{call_id}-{idx}"),
                    "timestamp": ts,
                    "message": {
                        "role": "toolResult",
                        "toolCallId": call_id,
                        "isError": false,
                        "content": [{ "type": "text", "text": text }],
                    }
                }));
            }
            _ => {}
        }
    }

    if !pending_thinking.is_empty() {
        let thinking = pending_thinking.join("\n\n");
        entries.push(json!({
            "type": "message",
            "id": "codex-ri-think-tail",
            "timestamp": "",
            "message": {
                "role": "assistant",
                "content": [{ "type": "thinking", "thinking": thinking }],
            }
        }));
    }

    entries
}

/// 将 Codex App Server JSON-RPC `error` 对象翻译为面向用户的中文错误提示：
/// - 写锁冲突 (`already has an active writer` / `thread-store conflict`) → 提示关闭其他 Codex 进程后重试
/// - 原供应商失效 (`modelProviderNotConfigured`) → 点名缺失的 provider 并引导检查 `~/.codex/config.toml`
/// - 上述已明确识别的业务错误不再拼接无关 `config.toml` 启动 stderr 警告噪音；其他错误保留 `stderr_diag` 供排查。
pub fn format_codex_rpc_error(action: &str, err: &Value, stderr_diag: &str) -> String {
    let msg = err
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let lower_msg = msg.map(|s| s.to_ascii_lowercase()).unwrap_or_default();

    if lower_msg.contains("already has an active writer")
        || lower_msg.contains("thread-store conflict")
    {
        return format!(
            "{action}失败：该会话正被其他 Codex 进程（如 Codex 桌面端、VS Code 插件或终端）占用，请先在对应客户端关闭该会话后重试"
        );
    }

    if let Some(provider) = extract_missing_model_provider(err) {
        return match provider {
            Some(p) => format!(
                "{action}失败：该历史会话原使用的模型供应商「{p}」未在 ~/.codex/config.toml 中配置，请先恢复 [model_providers.{p}] 配置，或新建 Codex 会话继续"
            ),
            None => format!(
                "{action}失败：该历史会话原使用的模型供应商未在 ~/.codex/config.toml 中配置，请先恢复对应配置，或新建 Codex 会话继续"
            ),
        };
    }

    let detail = msg
        .map(|s| s.to_string())
        .unwrap_or_else(|| err.to_string());
    format!("{action}失败：{detail}{stderr_diag}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_model_list_and_efforts() {
        let res = json!({
            "data": [
                {
                    "id": "gpt-6-astra",
                    "displayName": "GPT-6-Astra",
                    "isDefault": true,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "fast" },
                        { "reasoningEffort": "medium", "description": "balanced" },
                        { "reasoningEffort": "high", "description": "deep" },
                        { "reasoningEffort": "xhigh", "description": "extra" }
                    ]
                }
            ]
        });
        let models = parse_model_list(&res);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-6-astra");
        assert_eq!(models[0].name, "GPT-6-Astra");
        assert!(models[0].is_default);
        assert_eq!(models[0].default_effort.as_deref(), Some("medium"));
        assert_eq!(models[0].supported_efforts, vec!["low", "medium", "high", "xhigh"]);
    }

    #[test]
    fn token_breakdown_avoids_double_counting_cached_input() {
        let b = CodexTokenBreakdown::from_value(&json!({
            "inputTokens": 27047,
            "cachedInputTokens": 14976,
            "cacheWriteInputTokens": 0,
            "outputTokens": 184,
            "reasoningOutputTokens": 0,
            "totalTokens": 27231
        }));
        let u = b.to_message_usage().unwrap();
        assert_eq!(u.input, 12071);
        assert_eq!(u.cache_read, 14976);
        assert_eq!(u.output, 184);
        assert_eq!(u.input + u.cache_read + u.cache_write + u.output, 27231);
    }

    #[test]
    fn translates_streaming_turn_with_tools_plan_and_usage() {
        let mut tr = CodexStreamTranslator::new();
        tr.mark_prompt_dispatched();

        // turn/started 不会重复发出 TurnStart
        assert!(tr.translate_notification("turn/started", &json!({ "turn": { "id": "t1" } })).is_empty());

        // 推理增量
        let evs = tr.translate_notification(
            "item/reasoning/summaryTextDelta",
            &json!({ "itemId": "r1", "delta": "分析需求" }),
        );
        assert!(matches!(evs.last(), Some(UnifiedEvent::ThinkingDelta { delta }) if delta == "分析需求"));

        // 命令工具开始 → 先关闭前面推理气泡再发 ToolStart
        let evs = tr.translate_notification(
            "item/started",
            &json!({
                "item": {
                    "type": "commandExecution",
                    "id": "cmd1",
                    "command": "git status",
                    "cwd": "C:\\repo"
                }
            }),
        );
        assert!(matches!(evs[0], UnifiedEvent::AssistantEnd { .. }));
        assert!(matches!(&evs[1], UnifiedEvent::ToolStart { tool_call_id, tool_name, .. } if tool_call_id == "cmd1" && tool_name == "bash"));

        // 命令增量输出累积
        let u1 = tr.translate_notification(
            "item/commandExecution/outputDelta",
            &json!({ "itemId": "cmd1", "delta": "line1\n" }),
        );
        let u2 = tr.translate_notification(
            "item/commandExecution/outputDelta",
            &json!({ "itemId": "cmd1", "delta": "line2\n" }),
        );
        assert_eq!(u1.len(), 1);
        match &u2[0] {
            UnifiedEvent::ToolUpdate { partial_result, .. } => {
                assert_eq!(partial_result["content"][0]["text"], "line1\nline2\n");
            }
            other => panic!("unexpected: {other:?}"),
        }

        // 工具完成
        let end = tr.translate_notification(
            "item/completed",
            &json!({
                "item": {
                    "type": "commandExecution",
                    "id": "cmd1",
                    "command": "git status",
                    "status": "completed",
                    "exitCode": 0,
                    "aggregatedOutput": "line1\nline2\n"
                }
            }),
        );
        assert!(matches!(&end[0], UnifiedEvent::ToolEnd { tool_call_id, is_error: false, .. } if tool_call_id == "cmd1"));

        // 计划更新
        let pl = tr.translate_notification(
            "turn/plan/updated",
            &json!({
                "explanation": "执行计划",
                "plan": [
                    { "step": "检查状态", "status": "completed" },
                    { "step": "实现功能", "status": "inProgress" }
                ]
            }),
        );
        match &pl[0] {
            UnifiedEvent::PlanUpdate { plan } => {
                assert_eq!(plan.source, "codex_plan");
                assert_eq!(plan.title.as_deref(), Some("执行计划"));
                assert_eq!(plan.items[1].status, PlanItemStatus::InProgress);
            }
            other => panic!("unexpected: {other:?}"),
        }

        // 正文输出 → 新开 AssistantStart
        let txt = tr.translate_notification(
            "item/agentMessage/delta",
            &json!({ "itemId": "m1", "delta": "完成啦" }),
        );
        assert!(matches!(txt[0], UnifiedEvent::AssistantStart { .. }));
        assert!(matches!(txt.last(), Some(UnifiedEvent::TextDelta { delta }) if delta == "完成啦"));

        // Token 用量 + turn/completed
        let live = tr.translate_notification(
            "thread/tokenUsage/updated",
            &json!({
                "tokenUsage": {
                    "total": { "inputTokens": 1000, "cachedInputTokens": 400, "outputTokens": 50, "totalTokens": 1050 },
                    "last": { "inputTokens": 1000, "cachedInputTokens": 400, "outputTokens": 50, "totalTokens": 1050 },
                    "modelContextWindow": 200000
                }
            }),
        );
        assert!(matches!(live[0], UnifiedEvent::LiveUsage { input: 1000, output: 50 }));

        let done = tr.translate_notification(
            "turn/completed",
            &json!({ "turn": { "id": "t1", "status": "completed", "error": null } }),
        );
        assert!(matches!(done.last(), Some(UnifiedEvent::TurnSettled)));
        match &done[0] {
            UnifiedEvent::AssistantEnd { usage: Some(u), .. } => {
                assert_eq!(u.input, 600);
                assert_eq!(u.cache_read, 400);
                assert_eq!(u.output, 50);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn translates_approval_and_user_input_roundtrip() {
        let (req, kind) = translate_codex_approval_request(
            "item/commandExecution/requestApproval",
            "cdx-perm-1".into(),
            &json!({
                "itemId": "c1",
                "command": "rm -rf dist",
                "cwd": "C:\\repo",
                "reason": "清理产物"
            }),
        )
        .unwrap();
        assert_eq!(req.tool_name, "bash");
        assert_eq!(req.options.len(), 3);
        let resp = build_codex_approval_response(json!(7), &kind, true, Some("acceptForSession"));
        assert_eq!(resp["result"]["decision"], "acceptForSession");

        let prompt = translate_codex_user_input_request(
            "cdx-prompt-1".into(),
            &json!({
                "questions": [
                    {
                        "id": "db",
                        "header": "数据库",
                        "question": "选择数据库?",
                        "isOther": true,
                        "isSecret": false,
                        "options": [
                            { "label": "SQLite (Recommended)", "description": "轻量" },
                            { "label": "Postgres", "description": "服务化" }
                        ]
                    }
                ]
            }),
        )
        .unwrap();
        assert_eq!(prompt.questions.len(), 1);
        assert!(prompt.questions[0].options[0].recommended);

        let mut ans = HashMap::new();
        ans.insert("db".to_string(), vec!["SQLite (Recommended)".to_string()]);
        let reply = build_codex_user_input_response(
            json!(8),
            UserPromptResponse::Submit {
                answers: ans,
                confirmed: None,
                text: None,
            },
        );
        assert_eq!(reply["result"]["answers"]["db"]["answers"][0], "SQLite (Recommended)");
    }

    #[test]
    fn converts_thread_items_to_standard_history_entries() {
        let items = vec![
            (
                json!({ "type": "userMessage", "id": "u1", "content": [{ "type": "text", "text": "你好" }] }),
                Some("2026-11-24T10:00:00Z".into()),
            ),
            (
                json!({ "type": "reasoning", "id": "r1", "summary": ["先查状态"] }),
                None,
            ),
            (
                json!({ "type": "commandExecution", "id": "c1", "command": "ls", "cwd": ".", "status": "completed", "exitCode": 0, "aggregatedOutput": "a.txt" }),
                None,
            ),
            (
                json!({ "type": "agentMessage", "id": "a1", "text": "看到 a.txt" }),
                None,
            ),
        ];
        let entries = thread_items_to_entries(&items);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0]["message"]["role"], "user");
        assert_eq!(entries[1]["message"]["role"], "assistant");
        assert_eq!(entries[1]["message"]["content"][0]["type"], "thinking");
        assert_eq!(entries[1]["message"]["content"][1]["type"], "toolCall");
        assert_eq!(entries[2]["message"]["role"], "toolResult");
        assert_eq!(entries[3]["message"]["role"], "assistant");
        assert_eq!(entries[3]["message"]["content"][0]["text"], "看到 a.txt");
    }

    #[test]
    fn formats_codex_rpc_errors_for_lock_conflict_and_missing_provider() {
        let noisy_stderr = " (stderr: Codex is ignoring 3 unrecognized configuration settings.)";

        // 1. 写锁冲突: 输出清晰中文提示并抑制无关 stderr 噪音
        let lock_err = json!({
            "code": -32600,
            "message": "thread 01a20cac-fb3e-75f2-9fc9-83eb16694209 already has an active writer"
        });
        let msg = format_codex_rpc_error("恢复 Codex 会话", &lock_err, noisy_stderr);
        assert!(msg.contains("恢复 Codex 会话失败："));
        assert!(msg.contains("正在被") || msg.contains("正被其他 Codex 进程"));
        assert!(!msg.contains("unrecognized configuration"));

        // 2. 原模型供应商未配置 (带结构化 data.modelProvider)
        let provider_err = json!({
            "code": -32600,
            "data": { "type": "modelProviderNotConfigured", "modelProvider": "custom" },
            "message": "This chat uses model provider “custom”, which is no longer configured. Restore this provider’s configuration to continue."
        });
        let msg = format_codex_rpc_error("恢复 Codex 会话", &provider_err, noisy_stderr);
        assert!(msg.contains("「custom」"));
        assert!(msg.contains("[model_providers.custom]"));
        assert!(!msg.contains("unrecognized configuration"));

        // 3. 原模型供应商未配置 (仅 message 弯引号兜底)
        let provider_fallback_err = json!({
            "code": -32600,
            "message": "This chat uses model provider “privnode”, which is no longer configured."
        });
        let msg = format_codex_rpc_error("恢复 Codex 会话", &provider_fallback_err, noisy_stderr);
        assert!(msg.contains("「privnode」"));
        assert!(msg.contains("[model_providers.privnode]"));

        // 4. 其他未知错误: 提取干净 message 并保留 stderr 诊断信息
        let other_err = json!({
            "code": -32000,
            "message": "rollout file corrupted"
        });
        let msg = format_codex_rpc_error("恢复 Codex 会话", &other_err, noisy_stderr);
        assert_eq!(msg, format!("恢复 Codex 会话失败：rollout file corrupted{noisy_stderr}"));
    }

    #[test]
    fn sanitizes_response_items_for_cross_provider_migration() {
        // 1. compaction / 未知占位丢弃
        assert!(sanitize_response_item_for_migration(&json!({
            "type": "compaction",
            "encrypted_content": "abc"
        }))
        .is_none());

        // 2. 纯密文 reasoning 丢弃; 带可读 summary 的 reasoning 保留但清空 encrypted_content
        assert!(sanitize_response_item_for_migration(&json!({
            "type": "reasoning",
            "summary": [],
            "encrypted_content": "enc-only"
        }))
        .is_none());
        let kept_reason = sanitize_response_item_for_migration(&json!({
            "type": "reasoning",
            "summary": [{ "type": "summary_text", "text": "先查日志" }],
            "encrypted_content": "enc-blob"
        }))
        .unwrap();
        assert!(kept_reason["encrypted_content"].is_null());
        assert_eq!(kept_reason["summary"][0]["text"], "先查日志");

        // 3. function_call 同时清空 encrypted_content 与 encrypted_function_args
        let fc = sanitize_response_item_for_migration(&json!({
            "type": "function_call",
            "call_id": "call_1",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"ls\"}",
            "encrypted_content": "enc1",
            "encrypted_function_args": ["enc2"]
        }))
        .unwrap();
        assert!(fc["encrypted_content"].is_null());
        assert!(fc["encrypted_function_args"].is_null());

        // 4. agent_message 剔除嵌套 encrypted_content; 全部被剔除则丢弃整条
        let am = sanitize_response_item_for_migration(&json!({
            "type": "agent_message",
            "author": "a",
            "recipient": "b",
            "content": [
                { "type": "encrypted_content", "encrypted_content": "secret" },
                { "type": "input_text", "text": "可见文本" }
            ]
        }))
        .unwrap();
        assert_eq!(am["content"].as_array().unwrap().len(), 1);
        assert_eq!(am["content"][0]["text"], "可见文本");
        assert!(sanitize_response_item_for_migration(&json!({
            "type": "agent_message",
            "author": "a",
            "recipient": "b",
            "content": [{ "type": "encrypted_content", "encrypted_content": "only-secret" }]
        }))
        .is_none());

        // 5. function_call_output 若嵌套数组全为密文, 保底回填 "" 保持 call_id 配对
        let fco = sanitize_response_item_for_migration(&json!({
            "type": "function_call_output",
            "call_id": "call_1",
            "output": [{ "type": "encrypted_content", "encrypted_content": "only-secret" }]
        }))
        .unwrap();
        assert_eq!(fco["output"], "");

        // 6. 迁移请求不传 modelProvider (交由当前默认登录决定)
        let req = build_thread_resume_with_history_request(
            9,
            "orig-tid",
            vec![fc, fco],
            "C:\\repo",
            None,
            Some("auto"),
        );
        assert_eq!(req["method"], "thread/resume");
        assert!(req["params"].get("modelProvider").is_none());
        assert_eq!(req["params"]["history"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn converts_response_items_to_entries_filtering_injected_context() {
        let items = vec![
            (
                json!({
                    "type": "message",
                    "role": "developer",
                    "content": [{ "type": "input_text", "text": "<app-context>internal" }]
                }),
                None,
            ),
            (
                json!({
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "# AGENTS.md instructions for C:\\repo" },
                        { "type": "input_text", "text": "<environment_context><cwd>C:\\repo</cwd></environment_context>" }
                    ]
                }),
                None,
            ),
            (
                json!({
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "帮我看下登录接口" }]
                }),
                Some("2026-11-24T10:00:00Z".into()),
            ),
            (
                json!({
                    "type": "reasoning",
                    "summary": [{ "type": "summary_text", "text": "先定位路由" }]
                }),
                None,
            ),
            (
                json!({
                    "type": "function_call",
                    "call_id": "c1",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"rg login\"}"
                }),
                None,
            ),
            (
                json!({
                    "type": "function_call_output",
                    "call_id": "c1",
                    "output": "auth.rs:12"
                }),
                None,
            ),
            (
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "登录入口在 auth.rs" }]
                }),
                None,
            ),
        ];

        let entries = response_items_to_entries(&items);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0]["message"]["role"], "user");
        assert_eq!(entries[0]["message"]["content"][0]["text"], "帮我看下登录接口");
        assert_eq!(entries[1]["message"]["content"][0]["type"], "thinking");
        assert_eq!(entries[1]["message"]["content"][1]["type"], "toolCall");
        assert_eq!(entries[2]["message"]["role"], "toolResult");
        assert_eq!(entries[3]["message"]["role"], "assistant");
        assert_eq!(entries[3]["message"]["content"][0]["text"], "登录入口在 auth.rs");
    }
}
