//! Claude Code 历史会话文件系统数据源 (`~/.claude/projects/`):
//! - 扫描顶层会话 jsonl (提取权威 `cwd`、`sessionId`、首条真实用户消息摘要)
//! - 首帧直读转换为与前端 `mapHistoryEntries` 兼容的标准消息条目
//! - 路径边界校验 (防止越界读写/删除)

use crate::backends::claude::translate::normalize_tool_result_content;
use crate::backends::AgentKind;
use crate::session_fs::SessionInfo;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// `~/.claude/projects` 目录路径。
pub fn claude_projects_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法确定用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".claude").join("projects"))
}

/// 路径安全校验: 确认目标文件位于 `~/.claude/projects/` 根内。
pub fn ensure_within_claude_projects(path: &Path) -> Result<PathBuf, String> {
    let root = claude_projects_dir()?;
    let root_canon = root.canonicalize().unwrap_or(root);
    let abs = path
        .canonicalize()
        .map_err(|e| format!("Claude 会话文件不存在: {e}"))?;
    if !abs.starts_with(&root_canon) {
        return Err("拒绝访问非 Claude 会话目录内的文件".into());
    }
    Ok(abs)
}

/// 判断文本是否为 Claude 内部系统标签包裹而非用户自然语言输入。
fn clean_user_preview(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with("<local-command-caveat>")
        || trimmed.starts_with("<command-name>")
        || trimmed.starts_with("<system-reminder>")
    {
        return String::new();
    }
    trimmed.chars().take(120).collect()
}

/// 从 `message.content` (字符串或 content blocks 数组) 提取纯文本。
fn extract_user_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                    b.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// 扫描单个 Claude jsonl 头部: 返回 `(cwd, session_id, timestamp, preview)`。
fn inspect_claude_session_file(path: &Path) -> Option<(String, String, String, String)> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut cwd = String::new();
    let mut session_id = String::new();
    let mut first_ts = String::new();
    let mut preview = String::new();
    let mut custom_title = String::new();

    for (idx, line) in reader.lines().enumerate() {
        if idx > 200 && !cwd.is_empty() && !preview.is_empty() {
            break;
        }
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
                cwd = c.to_string();
            }
        }
        if session_id.is_empty() {
            if let Some(sid) = v
                .get("sessionId")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
            {
                session_id = sid.to_string();
            }
        }
        if first_ts.is_empty() {
            if let Some(ts) = v
                .get("timestamp")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
            {
                first_ts = ts.to_string();
            }
        }
        let ev_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if ev_type == "custom-title" {
            if let Some(t) = v
                .get("customTitle")
                .or_else(|| v.get("title"))
                .and_then(|x| x.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                custom_title = t.trim().to_string();
            }
        }
        if preview.is_empty()
            && ev_type == "user"
            && v.get("isSidechain").and_then(|x| x.as_bool()) != Some(true)
        {
            if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
                // 跳过纯 tool_result 回传行
                let is_only_tool_result = content.as_array().map_or(false, |arr| {
                    !arr.is_empty()
                        && arr
                            .iter()
                            .all(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                });
                if !is_only_tool_result {
                    let candidate = clean_user_preview(&extract_user_text(content));
                    if !candidate.is_empty() {
                        preview = candidate;
                    }
                }
            }
        }
    }

    if cwd.is_empty() {
        return None;
    }
    if session_id.is_empty() {
        session_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
    }
    let final_preview = if !custom_title.is_empty() {
        custom_title
    } else {
        preview
    };
    Some((cwd, session_id, first_ts, final_preview))
}

/// 扫描 `~/.claude/projects/` 下全部主会话 (深度 2: `<project-dir>/<uuid>.jsonl`)。
/// 返回 `(cwd, SessionInfo)` 列表供 `session_fs::list_projects_and_sessions` 合并。
pub fn list_claude_sessions() -> Vec<(String, SessionInfo)> {
    let Ok(root) = claude_projects_dir() else {
        return Vec::new();
    };
    if !root.exists() {
        return Vec::new();
    }
    let Ok(proj_dirs) = std::fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for dir_entry in proj_dirs.flatten() {
        let dir_path = dir_entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir_path) else {
            continue;
        };
        for f in files.flatten() {
            let fpath = f.path();
            if fpath.is_dir() || fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(file_name) = f.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };
            let Some((cwd, session_id, timestamp, preview)) = inspect_claude_session_file(&fpath)
            else {
                continue;
            };
            let mtime_ms = f
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            out.push((
                cwd,
                SessionInfo {
                    file_name,
                    session_path: fpath.to_string_lossy().to_string(),
                    timestamp,
                    session_id,
                    preview,
                    mtime_ms,
                    agent_kind: AgentKind::Claude,
                },
            ));
        }
    }
    out
}

/// 从 Claude jsonl 文件路径提取 `--resume` 所需的 `sessionId` (优先读文件内 `sessionId`, 回退文件名 stem)。
pub fn extract_claude_session_id(path: &Path) -> Option<String> {
    if let Some((_, sid, _, _)) = inspect_claude_session_file(path) {
        if !sid.is_empty() {
            return Some(sid);
        }
    }
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
}

/// 将 Claude jsonl 会话文件解析为与前端 `mapHistoryEntries` 兼容的标准条目数组:
/// - `user` 文本 → `{ type: "message", message: { role: "user", content: [{ type: "text", text }] } }`
/// - `user` 内的 `tool_result` → `{ type: "message", message: { role: "toolResult", toolCallId, isError, content } }`
/// - `assistant` → 将 `tool_use` 映射为 `toolCall { id, name, arguments }`, 保留 `text` / `thinking`
pub fn read_claude_session_entries(path: &Path) -> Result<Vec<Value>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开 Claude 会话文件失败: {e}"))?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            continue;
        }
        let ev_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let ts = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let entry_id = v
            .get("uuid")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();

        match ev_type {
            "user" => {
                let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
                    continue;
                };
                match content {
                    Value::String(s) => {
                        if !s.trim().is_empty() {
                            entries.push(json!({
                                "type": "message",
                                "id": entry_id,
                                "timestamp": ts,
                                "message": {
                                    "role": "user",
                                    "content": [{ "type": "text", "text": s }]
                                }
                            }));
                        }
                    }
                    Value::Array(arr) => {
                        let mut text_blocks = Vec::new();
                        for block in arr {
                            let bt = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
                            if bt == "tool_result" {
                                let tool_call_id = block
                                    .get("tool_use_id")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("");
                                if tool_call_id.is_empty() {
                                    continue;
                                }
                                let is_error = block
                                    .get("is_error")
                                    .and_then(|x| x.as_bool())
                                    .unwrap_or(false);
                                let raw = block.get("content").cloned().unwrap_or(Value::Null);
                                let norm = normalize_tool_result_content(raw);
                                entries.push(json!({
                                    "type": "message",
                                    "id": entry_id,
                                    "timestamp": ts,
                                    "message": {
                                        "role": "toolResult",
                                        "toolCallId": tool_call_id,
                                        "isError": is_error,
                                        "content": norm.get("content").cloned().unwrap_or(json!([]))
                                    }
                                }));
                            } else if bt == "text" {
                                if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                                    if !t.trim().is_empty() {
                                        text_blocks.push(json!({ "type": "text", "text": t }));
                                    }
                                }
                            }
                        }
                        if !text_blocks.is_empty() {
                            entries.push(json!({
                                "type": "message",
                                "id": entry_id,
                                "timestamp": ts,
                                "message": {
                                    "role": "user",
                                    "content": text_blocks
                                }
                            }));
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                let Some(content) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                else {
                    continue;
                };
                let mut blocks = Vec::new();
                for block in content {
                    let bt = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    match bt {
                        "text" => {
                            if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    blocks.push(json!({ "type": "text", "text": t }));
                                }
                            }
                        }
                        "thinking" => {
                            if let Some(t) = block.get("thinking").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    blocks.push(json!({ "type": "thinking", "thinking": t }));
                                }
                            }
                        }
                        "tool_use" => {
                            blocks.push(json!({
                                "type": "toolCall",
                                "id": block.get("id").cloned().unwrap_or(Value::Null),
                                "name": block.get("name").cloned().unwrap_or(Value::Null),
                                "arguments": block.get("input").cloned().unwrap_or(Value::Null),
                            }));
                        }
                        _ => {}
                    }
                }
                if !blocks.is_empty() {
                    entries.push(json!({
                        "type": "message",
                        "id": entry_id,
                        "timestamp": ts,
                        "message": {
                            "role": "assistant",
                            "content": blocks
                        }
                    }));
                }
            }
            _ => {}
        }
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_claude_jsonl_entries_for_replay() {
        let dir = std::env::temp_dir().join(format!(
            "kitsune-claude-hist-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sess-1.jsonl");
        let mut fp = std::fs::File::create(&file).unwrap();
        writeln!(
            fp,
            r#"{{"type":"user","uuid":"u1","cwd":"C:\\proj","sessionId":"sess-1","timestamp":"2026-11-20T01:00:00Z","message":{{"role":"user","content":"你好"}}}}"#
        )
        .unwrap();
        writeln!(
            fp,
            r#"{{"type":"assistant","uuid":"a1","cwd":"C:\\proj","sessionId":"sess-1","timestamp":"2026-11-20T01:00:01Z","message":{{"id":"m1","role":"assistant","content":[{{"type":"thinking","thinking":"想一下"}},{{"type":"tool_use","id":"tu1","name":"Read","input":{{"file_path":"a.ts"}}}}]}}}}"#
        )
        .unwrap();
        writeln!(
            fp,
            r#"{{"type":"user","uuid":"u2","cwd":"C:\\proj","sessionId":"sess-1","timestamp":"2026-11-20T01:00:02Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"tu1","content":"file body","is_error":false}}]}}}}"#
        )
        .unwrap();
        writeln!(
            fp,
            r#"{{"type":"assistant","uuid":"a2","cwd":"C:\\proj","sessionId":"sess-1","timestamp":"2026-11-20T01:00:03Z","message":{{"id":"m2","role":"assistant","content":[{{"type":"text","text":"读完了"}}]}}}}"#
        )
        .unwrap();
        drop(fp);

        let (cwd, sid, _, preview) = inspect_claude_session_file(&file).unwrap();
        assert_eq!(cwd, r"C:\proj");
        assert_eq!(sid, "sess-1");
        assert_eq!(preview, "你好");

        let entries = read_claude_session_entries(&file).unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0]["message"]["role"], "user");
        assert_eq!(entries[1]["message"]["content"][1]["type"], "toolCall");
        assert_eq!(entries[2]["message"]["role"], "toolResult");
        assert_eq!(entries[2]["message"]["toolCallId"], "tu1");
        assert_eq!(entries[3]["message"]["content"][0]["text"], "读完了");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
