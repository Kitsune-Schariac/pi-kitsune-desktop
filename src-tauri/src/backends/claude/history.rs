//! Claude Code 历史会话文件系统数据源 (`~/.claude/projects/`):
//! - 扫描顶层会话 jsonl (提取权威 `cwd`、`sessionId`、首条真实用户消息摘要)
//! - 首帧直读转换为与前端 `mapHistoryEntries` 兼容的标准消息条目
//! - 路径边界校验 (防止越界读写/删除)

use crate::backends::claude::translate::normalize_tool_result_content;
use crate::backends::AgentKind;
use crate::session_fs::SessionInfo;
use serde_json::{json, Value};
use std::collections::HashMap;
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

/// 从单个 Claude 会话 `.jsonl` 聚合出的历史统计快照 (供 `ClaudeBackend` 初始化 `get_session_stats`)。
#[derive(Debug, Clone, Default)]
pub struct ClaudeSessionStatsSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_usd: f64,
    pub user_messages: u64,
    pub assistant_messages: u64,
    /// 最近一次有效 LLM 调用的实际上下文占用 (`input + cache_read + cache_write`)
    pub last_context_tokens: Option<u64>,
    pub last_model: Option<String>,
    /// 若 `cost-state` 中记录了权威 `contextWindow`, 记录之
    pub context_window: Option<u64>,
}

/// 当尚未收到 `result.modelUsage.<model>.contextWindow` 权威值时，按模型名推断上下文窗口上限。
/// 实机 (`claude 2.1.329`) `claude-opus-5-5` 权威返回 `1_000_000`；老款 4.5 / Haiku 4.5 等默认 `200_000`。
pub fn infer_claude_context_window(model: Option<&str>, used_tokens: Option<u64>) -> u64 {
    let mut window = match model.map(|s| s.to_ascii_lowercase()) {
        Some(ref m)
            if m.contains("[1m]")
                || m.contains("-1m")
                || m.contains("opus-5")
                || m.contains("sonnet-5")
                || m.contains("fable-5")
                || m.contains("haiku-5")
                || m.contains("opus-4-6")
                || m.contains("opus-4-7")
                || m.contains("opus-4-8")
                || m.contains("sonnet-4-6") =>
        {
            1_000_000
        }
        _ => 200_000,
    };
    if let Some(used) = used_tokens {
        if used > window {
            window = if used <= 1_000_000 { 1_000_000 } else { used };
        }
    }
    window
}

/// 扫描单个 Claude `.jsonl` 文件还原历史统计与当前上下文占用：
/// - 同一 `message.id` 按块落盘多行且携带重复 usage，必须按 `message.id` 去重（保留末次快照）
/// - 上下文占用按 Anthropic 口径取末次有效调用的 `input + cache_read + cache_write`
/// - 若存在 `cost-state` 行，采用其最新 `totalCostUSD` 与 `modelUsage.*.contextWindow`
pub fn read_claude_session_stats(path: &Path) -> ClaudeSessionStatsSnapshot {
    let Ok(file) = std::fs::File::open(path) else {
        return ClaudeSessionStatsSnapshot::default();
    };
    let reader = BufReader::new(file);

    struct DedupRow {
        model: Option<String>,
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
    }

    let mut dedup_idx: HashMap<String, usize> = HashMap::new();
    let mut dedup_rows: Vec<DedupRow> = Vec::new();
    let mut user_messages: u64 = 0;
    let mut cost_usd: f64 = 0.0;
    let mut context_window: Option<u64> = None;

    for (line_no, line) in reader.lines().enumerate() {
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
        match ev_type {
            "user" => {
                if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
                    let is_only_tool_result = content.as_array().map_or(false, |arr| {
                        !arr.is_empty()
                            && arr
                                .iter()
                                .all(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                    });
                    if !is_only_tool_result {
                        let text = extract_user_text(content);
                        if !clean_user_preview(&text).is_empty() {
                            user_messages += 1;
                        }
                    }
                }
            }
            "assistant" => {
                let Some(msg) = v.get("message") else { continue };
                let Some(u) = msg.get("usage") else { continue };
                let input = u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                let output = u.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                let cache_read = u
                    .get("cache_read_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let cache_write = u
                    .get("cache_creation_input_tokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
                    continue;
                }
                let model = msg
                    .get("model")
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let key = msg
                    .get("id")
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("__line_{line_no}"));
                let row = DedupRow {
                    model,
                    input,
                    output,
                    cache_read,
                    cache_write,
                };
                if let Some(&idx) = dedup_idx.get(&key) {
                    dedup_rows[idx] = row;
                } else {
                    let idx = dedup_rows.len();
                    dedup_idx.insert(key, idx);
                    dedup_rows.push(row);
                }
            }
            "cost-state" => {
                if let Some(c) = v.get("totalCostUSD").and_then(|x| x.as_f64()) {
                    if c > 0.0 {
                        cost_usd = c;
                    }
                }
                if let Some(mu) = v.get("modelUsage").and_then(|x| x.as_object()) {
                    for entry in mu.values() {
                        if let Some(cw) = entry.get("contextWindow").and_then(|x| x.as_u64()) {
                            if cw > 0 {
                                context_window = Some(cw);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut snap = ClaudeSessionStatsSnapshot {
        user_messages,
        assistant_messages: dedup_rows.len() as u64,
        cost_usd,
        context_window,
        ..Default::default()
    };
    for row in dedup_rows {
        snap.input_tokens += row.input;
        snap.output_tokens += row.output;
        snap.cache_read_tokens += row.cache_read;
        snap.cache_write_tokens += row.cache_write;
        let ctx = row.input + row.cache_read + row.cache_write;
        if ctx > 0 {
            snap.last_context_tokens = Some(ctx);
        }
        if row.model.is_some() {
            snap.last_model = row.model;
        }
    }
    snap
}

/// 按 `session_id` 反查 `~/.claude/projects/*/<session_id>.jsonl` 落盘路径 (新建会话落盘后对账用)。
pub fn locate_claude_session_file(session_id: &str) -> Option<PathBuf> {
    if session_id.trim().is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return None;
    }
    let root = claude_projects_dir().ok()?;
    let dirs = std::fs::read_dir(&root).ok()?;
    let target_name = format!("{session_id}.jsonl");
    for entry in dirs.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let candidate = p.join(&target_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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

    #[test]
    fn aggregates_claude_session_stats_with_dedup_and_context_window() {
        let dir = std::env::temp_dir().join(format!(
            "kitsune-claude-stats-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sess-stats.jsonl");
        let mut fp = std::fs::File::create(&file).unwrap();
        writeln!(
            fp,
            r#"{{"type":"user","uuid":"u1","cwd":"C:\\proj","sessionId":"s1","message":{{"role":"user","content":"分析代码"}}}}"#
        ).unwrap();
        // 同 message.id 分两行写 (thinking + text), 必须去重不重复累加
        writeln!(
            fp,
            r#"{{"type":"assistant","uuid":"a1","message":{{"id":"m1","model":"claude-opus-5-5","role":"assistant","content":[{{"type":"thinking","thinking":"x"}}],"usage":{{"input_tokens":2,"cache_creation_input_tokens":10000,"cache_read_input_tokens":0,"output_tokens":50}}}}}}"#
        ).unwrap();
        writeln!(
            fp,
            r#"{{"type":"assistant","uuid":"a2","message":{{"id":"m1","model":"claude-opus-5-5","role":"assistant","content":[{{"type":"text","text":"ok"}}],"usage":{{"input_tokens":2,"cache_creation_input_tokens":10000,"cache_read_input_tokens":0,"output_tokens":120}}}}}}"#
        ).unwrap();
        writeln!(
            fp,
            r#"{{"type":"assistant","uuid":"a3","message":{{"id":"m2","model":"claude-opus-5-5","role":"assistant","content":[{{"type":"text","text":"done"}}],"usage":{{"input_tokens":5,"cache_creation_input_tokens":500,"cache_read_input_tokens":10000,"output_tokens":80}}}}}}"#
        ).unwrap();
        writeln!(
            fp,
            r#"{{"type":"cost-state","sessionId":"s1","totalCostUSD":0.42,"modelUsage":{{"claude-opus-5-5":{{"contextWindow":1000000,"costUSD":0.42}}}}}}"#
        ).unwrap();
        drop(fp);

        let snap = read_claude_session_stats(&file);
        assert_eq!(snap.user_messages, 1);
        assert_eq!(snap.assistant_messages, 2);
        assert_eq!(snap.input_tokens, 7);
        assert_eq!(snap.output_tokens, 200);
        assert_eq!(snap.cache_write_tokens, 10500);
        assert_eq!(snap.cache_read_tokens, 10000);
        assert_eq!(snap.last_context_tokens, Some(10505));
        assert_eq!(snap.last_model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(snap.context_window, Some(1_000_000));
        assert!((snap.cost_usd - 0.42).abs() < 1e-6);

        assert_eq!(infer_claude_context_window(Some("claude-opus-5-5"), Some(100)), 1_000_000);
        assert_eq!(infer_claude_context_window(Some("claude-haiku-4-5-20251001"), Some(50_000)), 200_000);
        assert_eq!(infer_claude_context_window(Some("claude-haiku-4-5-20251001"), Some(250_000)), 1_000_000);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
