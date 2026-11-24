//! 跨 Agent 统一提问引导回复 (Guided Prompt / AskUser) 领域模型与协议转换纯函数。
//!
//! 设计原则:
//! - 前端仅渲染统一的 `UserPromptRequest` 并回传 `UserPromptResponse`, 零 `agentKind` 私有分支。
//! - 各后端 (Claude `AskUserQuestion` / Pi `extension_ui_request` / 未来 Codex `requestUserInput`
//!   与 ACP 提问扩展) 只需把私有请求映射到本模块类型, 并在 `respond_user_prompt` 中逆向回写。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

/// 引导回复卡片交互模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserPromptKind {
    Questions,
    Confirm,
    Input,
    Editor,
}

/// 单个候选项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub recommended: bool,
}

/// 单道结构化问题 (单选 / 多选 / 可选自定义输入)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptQuestion {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default)]
    pub options: Vec<PromptOption>,
    #[serde(default)]
    pub allow_custom: bool,
}

/// 统一引导回复请求载荷 (通过 `UnifiedEvent::UserPrompt` 发往前端)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPromptRequest {
    pub id: String,
    pub kind: UserPromptKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub questions: Vec<PromptQuestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefill: Option<String>,
    #[serde(default = "default_true")]
    pub allow_cancel: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_tool: Option<String>,
}

fn default_true() -> bool {
    true
}

/// 前端提交的统一引导回复响应 (经 `respond_user_prompt` 命令发回 Rust)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum UserPromptResponse {
    #[serde(rename_all = "camelCase")]
    Submit {
        #[serde(default)]
        answers: HashMap<String, Vec<String>>,
        #[serde(default)]
        confirmed: Option<bool>,
        #[serde(default)]
        text: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Cancel {
        #[serde(default)]
        reason: Option<String>,
    },
}

/// 判断工具名是否为 Claude Code 的结构化提问工具 `AskUserQuestion`。
pub fn is_claude_ask_user_tool(tool_name: &str) -> bool {
    tool_name.eq_ignore_ascii_case("AskUserQuestion")
}

/// 将 Claude Code `can_use_tool(AskUserQuestion)` 的 `input` 翻译为统一 `UserPromptRequest`。
pub fn parse_claude_ask_user_question(
    request_id: String,
    input: &Value,
    description: Option<String>,
) -> Option<UserPromptRequest> {
    let arr = input.get("questions").and_then(|v| v.as_array())?;
    let mut questions = Vec::with_capacity(arr.len());

    for (idx, q) in arr.iter().enumerate() {
        let prompt_text = q
            .get("question")
            .or_else(|| q.get("prompt"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())?
            .to_string();
        let header = q
            .get("header")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let multi_select = q
            .get("multiSelect")
            .or_else(|| q.get("multi_select"))
            .or_else(|| q.get("is_multi_select"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let options: Vec<PromptOption> = q
            .get("options")
            .and_then(|v| v.as_array())
            .map(|opts| {
                opts.iter()
                    .filter_map(|o| {
                        let raw_label = match o {
                            Value::String(s) => s.trim().to_string(),
                            Value::Object(_) => o
                                .get("label")
                                .or_else(|| o.get("value"))
                                .and_then(|v| v.as_str())
                                .map(str::trim)
                                .unwrap_or("")
                                .to_string(),
                            _ => String::new(),
                        };
                        if raw_label.is_empty() {
                            return None;
                        }
                        let desc = o
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());
                        let recommended = raw_label.contains("(Recommended)")
                            || raw_label.contains("（推荐）")
                            || o.get("recommended")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                        Some(PromptOption {
                            id: raw_label.clone(),
                            label: raw_label,
                            description: desc,
                            recommended,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        // Claude Code 协议规定 answers 的 key 就是 question 原文; 保底防空
        let id = q
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                if prompt_text.is_empty() {
                    format!("q{}", idx + 1)
                } else {
                    prompt_text.clone()
                }
            });

        questions.push(PromptQuestion {
            id,
            header,
            prompt: prompt_text,
            multi_select,
            options,
            // Claude Code 约定每题默认允许用户填自定义「其他」回复
            allow_custom: true,
        });
    }

    if questions.is_empty() {
        return None;
    }

    Some(UserPromptRequest {
        id: request_id,
        kind: UserPromptKind::Questions,
        title: Some("需要你的决定".to_string()),
        description,
        questions,
        placeholder: None,
        prefill: None,
        allow_cancel: true,
        source_tool: Some("AskUserQuestion".to_string()),
    })
}

/// 将统一 `UserPromptResponse` 合并回 Claude Code `AskUserQuestion` 要求的 `updatedInput` 载荷。
/// Claude 约定: `{ questions: [...], answers: { "<question>": "<label>" 或 "<a, b>" } }`。
pub fn build_claude_ask_user_control_payload(
    orig_input: Value,
    response: UserPromptResponse,
) -> Value {
    match response {
        UserPromptResponse::Submit { answers, .. } => {
            let mut answer_map = serde_json::Map::new();
            for (k, vals) in answers {
                let joined = vals
                    .into_iter()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ");
                if !joined.is_empty() {
                    answer_map.insert(k, Value::String(joined));
                }
            }
            let mut updated = match orig_input {
                Value::Object(map) => map,
                _ => serde_json::Map::new(),
            };
            updated.insert("answers".to_string(), Value::Object(answer_map));
            json!({
                "behavior": "allow",
                "updatedInput": Value::Object(updated),
            })
        }
        UserPromptResponse::Cancel { reason } => {
            json!({
                "behavior": "deny",
                "message": reason.unwrap_or_else(|| "用户取消了提问作答".to_string()),
            })
        }
    }
}

/// 将 Pi `extension_ui_request` (`confirm` / `select` / `input` / `editor`) 翻译为统一 `UserPromptRequest`。
pub fn parse_pi_extension_ui_request(frame: &Value) -> Option<UserPromptRequest> {
    let id = frame
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())?
        .to_string();
    let method = frame.get("method").and_then(|v| v.as_str())?;
    let title = frame
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let message = frame
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    match method {
        "confirm" => Some(UserPromptRequest {
            id,
            kind: UserPromptKind::Confirm,
            title: title.or_else(|| Some("请确认".to_string())),
            description: message.or_else(|| Some("请确认是否继续此操作".to_string())),
            questions: Vec::new(),
            placeholder: None,
            prefill: None,
            allow_cancel: true,
            source_tool: Some("pi_extension_ui".to_string()),
        }),
        "select" => {
            let options: Vec<PromptOption> = frame
                .get("options")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| {
                            let s = o.as_str()?.trim().to_string();
                            if s.is_empty() {
                                return None;
                            }
                            Some(PromptOption {
                                id: s.clone(),
                                label: s,
                                description: None,
                                recommended: false,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let prompt_text = message
                .clone()
                .or_else(|| title.clone())
                .unwrap_or_else(|| "请选择一项".to_string());
            Some(UserPromptRequest {
                id,
                kind: UserPromptKind::Questions,
                title: title.or_else(|| Some("请选择".to_string())),
                description: None,
                questions: vec![PromptQuestion {
                    id: "value".to_string(),
                    header: None,
                    prompt: prompt_text,
                    multi_select: false,
                    options,
                    allow_custom: false,
                }],
                placeholder: None,
                prefill: None,
                allow_cancel: true,
                source_tool: Some("pi_extension_ui".to_string()),
            })
        }
        "input" | "editor" => {
            let kind = if method == "editor" {
                UserPromptKind::Editor
            } else {
                UserPromptKind::Input
            };
            let placeholder = frame
                .get("placeholder")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let prefill = frame
                .get("prefill")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Some(UserPromptRequest {
                id,
                kind,
                title: title.or_else(|| {
                    Some(if method == "editor" {
                        "编辑文本".to_string()
                    } else {
                        "输入内容".to_string()
                    })
                }),
                description: message,
                questions: Vec::new(),
                placeholder,
                prefill,
                allow_cancel: true,
                source_tool: Some("pi_extension_ui".to_string()),
            })
        }
        _ => None,
    }
}

/// 将统一 `UserPromptResponse` 转为 Pi `extension_ui_response` 帧载荷 (不含 `type`/`id`, 由 `PiBackend` 补齐)。
pub fn build_pi_extension_ui_payload(kind: UserPromptKind, response: UserPromptResponse) -> Value {
    match response {
        UserPromptResponse::Cancel { .. } => json!({ "cancelled": true }),
        UserPromptResponse::Submit {
            answers,
            confirmed,
            text,
        } => match kind {
            UserPromptKind::Confirm => {
                json!({ "confirmed": confirmed.unwrap_or(true) })
            }
            UserPromptKind::Questions => {
                let picked = answers
                    .get("value")
                    .and_then(|v| v.first())
                    .or_else(|| answers.values().find_map(|v| v.first()))
                    .cloned()
                    .unwrap_or_default();
                json!({ "value": picked })
            }
            UserPromptKind::Input | UserPromptKind::Editor => {
                json!({ "value": text.unwrap_or_default() })
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_ask_user_question_and_builds_updated_input() {
        let input = json!({
            "questions": [
                {
                    "header": "Database",
                    "question": "Which database?",
                    "multiSelect": false,
                    "options": [
                        { "label": "PostgreSQL (Recommended)", "description": "ACID relational DB" },
                        { "label": "SQLite", "description": "Embedded local DB" }
                    ]
                },
                {
                    "header": "Features",
                    "question": "Which features?",
                    "multiSelect": true,
                    "options": [
                        { "label": "Logs", "description": "Disk logging" },
                        { "label": "Metrics", "description": "Prometheus" }
                    ]
                }
            ]
        });

        let req = parse_claude_ask_user_question("req_1".into(), &input, None)
            .expect("should parse AskUserQuestion");
        assert_eq!(req.kind, UserPromptKind::Questions);
        assert_eq!(req.questions.len(), 2);
        assert!(req.questions[0].options[0].recommended);
        assert!(req.questions[0].allow_custom);
        assert!(req.questions[1].multi_select);

        let mut answers = HashMap::new();
        answers.insert(
            "Which database?".to_string(),
            vec!["PostgreSQL (Recommended)".to_string()],
        );
        answers.insert(
            "Which features?".to_string(),
            vec!["Logs".to_string(), "Metrics".to_string()],
        );

        let payload = build_claude_ask_user_control_payload(
            input,
            UserPromptResponse::Submit {
                answers,
                confirmed: None,
                text: None,
            },
        );
        assert_eq!(payload["behavior"], "allow");
        assert_eq!(
            payload["updatedInput"]["answers"]["Which database?"],
            "PostgreSQL (Recommended)"
        );
        assert_eq!(
            payload["updatedInput"]["answers"]["Which features?"],
            "Logs, Metrics"
        );
        assert_eq!(payload["updatedInput"]["questions"].as_array().unwrap().len(), 2);

        let deny = build_claude_ask_user_control_payload(
            json!({}),
            UserPromptResponse::Cancel { reason: None },
        );
        assert_eq!(deny["behavior"], "deny");
    }

    #[test]
    fn parses_and_serializes_pi_extension_ui_methods() {
        let sel = parse_pi_extension_ui_request(&json!({
            "type": "extension_ui_request",
            "id": "ui-1",
            "method": "select",
            "title": "Pick env",
            "options": ["dev", "prod"]
        }))
        .unwrap();
        assert_eq!(sel.kind, UserPromptKind::Questions);
        assert_eq!(sel.questions[0].options.len(), 2);
        assert!(!sel.questions[0].allow_custom);

        let mut ans = HashMap::new();
        ans.insert("value".into(), vec!["prod".into()]);
        assert_eq!(
            build_pi_extension_ui_payload(
                UserPromptKind::Questions,
                UserPromptResponse::Submit {
                    answers: ans,
                    confirmed: None,
                    text: None
                }
            ),
            json!({ "value": "prod" })
        );

        let cfm = parse_pi_extension_ui_request(&json!({
            "type": "extension_ui_request",
            "id": "ui-2",
            "method": "confirm",
            "title": "Delete?",
            "message": "Sure?"
        }))
        .unwrap();
        assert_eq!(cfm.kind, UserPromptKind::Confirm);
        assert_eq!(
            build_pi_extension_ui_payload(
                UserPromptKind::Confirm,
                UserPromptResponse::Submit {
                    answers: HashMap::new(),
                    confirmed: Some(true),
                    text: None
                }
            ),
            json!({ "confirmed": true })
        );

        let ed = parse_pi_extension_ui_request(&json!({
            "type": "extension_ui_request",
            "id": "ui-3",
            "method": "editor",
            "title": "Edit note",
            "prefill": "hello"
        }))
        .unwrap();
        assert_eq!(ed.kind, UserPromptKind::Editor);
        assert_eq!(ed.prefill.as_deref(), Some("hello"));
        assert_eq!(
            build_pi_extension_ui_payload(
                UserPromptKind::Editor,
                UserPromptResponse::Submit {
                    answers: HashMap::new(),
                    confirmed: None,
                    text: Some("world".into())
                }
            ),
            json!({ "value": "world" })
        );
        assert_eq!(
            build_pi_extension_ui_payload(
                UserPromptKind::Editor,
                UserPromptResponse::Cancel { reason: None }
            ),
            json!({ "cancelled": true })
        );
    }
}
