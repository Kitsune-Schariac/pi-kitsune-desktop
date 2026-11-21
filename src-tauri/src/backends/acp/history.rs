//! Antigravity CLI (`agy acp`) 本地历史会话数据源 (`~/.gemini/antigravity-cli/`):
//! - 只读扫描 `conversation_summaries.db` 中 `app_data_dir = 'antigravity-cli'` 且 `step_count > 0`
//!   的 CLI/ACP 会话（刻意排除 Antigravity IDE 会话与空会话）
//! - 解析 `workspace_uris`（支持 `file:///c%3A/...` / `file:///C:/...` 百分号解码与归一化）
//! - 解析 `brain/<id>/.system_generated/logs/transcript.jsonl` 作为历史回放兜底、`@` 引用与历史统计来源
//! - 路径边界校验与安全删除

use crate::backends::AgentKind;
use crate::session_fs::SessionInfo;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `~/.gemini/antigravity-cli` 根目录。
pub fn antigravity_cli_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法确定用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".gemini").join("antigravity-cli"))
}

/// `~/.gemini/antigravity-cli/conversations` 目录。
pub fn antigravity_cli_conversations_dir() -> Result<PathBuf, String> {
    Ok(antigravity_cli_dir()?.join("conversations"))
}

fn is_safe_session_id(id: &str) -> bool {
    let s = id.trim();
    !s.is_empty()
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains("..")
        && !s.contains('\0')
}

/// 由 `acp_session_id` 构造规范会话文件路径 (`~/.gemini/antigravity-cli/conversations/<id>.db`)。
pub fn agy_conversation_db_path(session_id: &str) -> Option<String> {
    if !is_safe_session_id(session_id) {
        return None;
    }
    let dir = antigravity_cli_conversations_dir().ok()?;
    Some(dir.join(format!("{session_id}.db")).to_string_lossy().to_string())
}

/// 路径安全校验: 确认目标 `.db` 文件位于 `~/.gemini/antigravity-cli/conversations/` 根内。
pub fn ensure_within_agy_conversations(path: &Path) -> Result<PathBuf, String> {
    let root = antigravity_cli_conversations_dir()?;
    let root_canon = root.canonicalize().unwrap_or(root);
    let abs = path
        .canonicalize()
        .map_err(|e| format!("Antigravity 会话文件不存在: {e}"))?;
    if !abs.starts_with(&root_canon) {
        return Err("拒绝访问非 Antigravity CLI 会话目录内的文件".into());
    }
    if abs.extension().and_then(|e| e.to_str()) != Some("db") {
        return Err("目标文件不是有效的 Antigravity 会话文件".into());
    }
    Ok(abs)
}

/// 从 `session_path` (`.../<uuid>.db`) 或裸 `<uuid>` 提取 `session/load` 所需的 `sessionId`。
pub fn extract_agy_session_id(path_or_id: &str) -> Option<String> {
    let trimmed = path_or_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = Path::new(trimmed);
    if trimmed.ends_with(".db") || trimmed.contains('\\') || trimmed.contains('/') {
        let stem = p.file_stem()?.to_str()?.trim();
        return is_safe_session_id(stem).then(|| stem.to_string());
    }
    is_safe_session_id(trimmed).then(|| trimmed.to_string())
}

/// 百分号 URL 解码 (支持 UTF-8 中文路径与 `%3A` 盘符冒号)。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h1 = (bytes[i + 1] as char).to_digit(16);
            let h2 = (bytes[i + 2] as char).to_digit(16);
            if let (Some(a), Some(b)) = (h1, h2) {
                out.push(((a << 4) | b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 将 AGY 的 `workspace_uris` 单项 (`file:///c%3A/workspace/...`, `/C:/workspace/...` 等)
/// 规范化为本地文件系统路径 (Windows 转为 `C:\...`, Unix 保留 `/...`)。
pub fn decode_file_uri_to_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = trimmed
        .strip_prefix("file://")
        .unwrap_or(trimmed);
    let mut decoded = percent_decode(stripped);

    // `/c:/foo` 或 `/C:/foo` → 去掉前导斜杠
    let b = decoded.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        decoded.remove(0);
    }

    // Windows 盘符路径规范化: 首字母大写 + 反斜杠
    let b2 = decoded.as_bytes();
    if b2.len() >= 2 && b2[0].is_ascii_alphabetic() && b2[1] == b':' {
        let drive = (b2[0] as char).to_ascii_uppercase();
        let rest = decoded[1..].replace('/', "\\");
        let normalized = format!("{drive}{rest}");
        let trimmed_end = normalized.trim_end_matches('\\');
        if trimmed_end.len() == 2 && trimmed_end.ends_with(':') {
            return Some(format!("{trimmed_end}\\"));
        }
        return Some(trimmed_end.to_string());
    }

    let cleaned = decoded.trim_end_matches('/').to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// 解析 `workspace_uris` 列 (JSON 字符串数组) 取首个有效项目路径。
fn extract_first_workspace_path(workspace_uris: &str) -> Option<String> {
    let trimmed = workspace_uris.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(trimmed) {
        for item in arr {
            if let Some(uri) = item.as_str() {
                if let Some(p) = decode_file_uri_to_path(uri) {
                    return Some(p);
                }
            }
        }
    }
    decode_file_uri_to_path(trimmed)
}

/// 解析 SQLite `last_modified_time` (如 `2026-11-21 15:25:28.4438783+00:00` 或 `2026-11-20T12:16:13Z`)
/// → `(iso_utc_string, epoch_ms)`。`0001-01-01` 等零值返回 `None`。
pub fn parse_agy_timestamp(raw: &str) -> Option<(String, u64)> {
    let s = raw.trim();
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b' ' && b[10] != b'T')
        || b[13] != b':' || b[16] != b':'
    {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let mut v: i64 = 0;
        for &c in &b[from..to] {
            if !c.is_ascii_digit() {
                return None;
            }
            v = v * 10 + (c - b'0') as i64;
        }
        Some(v)
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if y < 1970 || !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy / 400;
    let yoe = yy - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    if days < 0 {
        return None;
    }
    let ms = (days * 86_400 + h * 3_600 + mi * 60 + se) as u64 * 1000;
    let iso = format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{se:02}Z");
    Some((iso, ms))
}

/// 从指定 SQLite 数据库 + `conversations/` 目录读取全部 `antigravity-cli` 历史会话。
fn list_agy_sessions_from(db_path: &Path, conversations_dir: &Path) -> Vec<(String, SessionInfo)> {
    if !db_path.is_file() {
        return Vec::new();
    }
    let Ok(conn) = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let _ = conn.busy_timeout(Duration::from_millis(200));

    let Ok(mut stmt) = conn.prepare(
        "SELECT conversation_id, title, preview, last_modified_time, workspace_uris \
         FROM conversation_summaries \
         WHERE app_data_dir = 'antigravity-cli' AND step_count > 0 \
         ORDER BY last_modified_time DESC",
    ) else {
        return Vec::new();
    };

    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1).unwrap_or_default(),
            row.get::<_, String>(2).unwrap_or_default(),
            row.get::<_, String>(3).unwrap_or_default(),
            row.get::<_, String>(4).unwrap_or_default(),
        ))
    }) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for row in rows.flatten() {
        let (conv_id, title, preview_col, last_mod, ws_uris) = row;
        if !is_safe_session_id(&conv_id) {
            continue;
        }
        let db_file = conversations_dir.join(format!("{conv_id}.db"));
        if !db_file.is_file() {
            continue;
        }
        let Some(cwd) = extract_first_workspace_path(&ws_uris) else {
            continue;
        };

        let raw_title = if !title.trim().is_empty() {
            title.trim()
        } else {
            preview_col.trim()
        };
        let preview: String = raw_title.chars().take(120).collect();

        let (timestamp, parsed_ms) = match parse_agy_timestamp(&last_mod) {
            Some((iso, ms)) => (iso, Some(ms)),
            None => (String::new(), None),
        };
        let file_mtime_ms = std::fs::metadata(&db_file)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        let mtime_ms = match (parsed_ms, file_mtime_ms) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };

        out.push((
            cwd,
            SessionInfo {
                file_name: format!("{conv_id}.db"),
                session_path: db_file.to_string_lossy().to_string(),
                timestamp,
                session_id: conv_id,
                preview,
                mtime_ms,
                agent_kind: AgentKind::Agy,
            },
        ));
    }
    out
}

/// 扫描本机 `~/.gemini/antigravity-cli/conversation_summaries.db` 中所有 CLI/ACP 会话。
pub fn list_agy_sessions() -> Vec<(String, SessionInfo)> {
    let Ok(root) = antigravity_cli_dir() else {
        return Vec::new();
    };
    list_agy_sessions_from(&root.join("conversation_summaries.db"), &root.join("conversations"))
}

/// 剥离 AGY `USER_INPUT` 外层的 `<USER_REQUEST>...</USER_REQUEST>` 系统包裹标签。
fn extract_user_request_body(raw: &str) -> String {
    if let Some(start) = raw.find("<USER_REQUEST>") {
        let after = &raw[start + "<USER_REQUEST>".len()..];
        if let Some(end) = after.find("</USER_REQUEST>") {
            return after[..end].trim().to_string();
        }
    }
    raw.trim().to_string()
}

fn agy_transcript_path(session_id: &str) -> Option<PathBuf> {
    if !is_safe_session_id(session_id) {
        return None;
    }
    let root = antigravity_cli_dir().ok()?;
    let p = root
        .join("brain")
        .join(session_id)
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl");
    p.is_file().then_some(p)
}

/// 从 `transcript.jsonl` 解析与前端 `mapHistoryEntries` 兼容的标准消息条目。
pub fn read_agy_transcript_entries_from(path: &Path) -> Vec<Value> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for (idx, line) in reader.lines().enumerate() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let step_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let ts = v
            .get("created_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let step_id = format!(
            "agy-step-{}",
            v.get("step_index")
                .and_then(|x| x.as_u64())
                .unwrap_or(idx as u64)
        );

        match step_type {
            "USER_INPUT" => {
                let raw = v.get("content").and_then(|x| x.as_str()).unwrap_or("");
                let text = extract_user_request_body(raw);
                if !text.is_empty() {
                    entries.push(json!({
                        "type": "message",
                        "id": step_id,
                        "timestamp": ts,
                        "message": {
                            "role": "user",
                            "content": [{ "type": "text", "text": text }]
                        }
                    }));
                }
            }
            "PLANNER_RESPONSE" => {
                let mut blocks = Vec::new();
                if let Some(thinking) = v.get("thinking").and_then(|x| x.as_str()) {
                    if !thinking.is_empty() {
                        blocks.push(json!({ "type": "thinking", "thinking": thinking }));
                    }
                }
                if let Some(text) = v.get("content").and_then(|x| x.as_str()) {
                    if !text.is_empty() {
                        blocks.push(json!({ "type": "text", "text": text }));
                    }
                }
                if let Some(tcs) = v.get("tool_calls").and_then(|x| x.as_array()) {
                    for (ti, tc) in tcs.iter().enumerate() {
                        let name = tc
                            .get("name")
                            .and_then(|x| x.as_str())
                            .unwrap_or("tool");
                        let args = tc.get("args").cloned().unwrap_or(Value::Null);
                        let tc_id = tc
                            .get("id")
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("{step_id}-tc-{ti}"));
                        blocks.push(json!({
                            "type": "toolCall",
                            "id": tc_id,
                            "name": name,
                            "arguments": args,
                        }));
                    }
                }
                if !blocks.is_empty() {
                    entries.push(json!({
                        "type": "message",
                        "id": step_id,
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

    entries
}

/// 读取指定 AGY 会话的 `transcript.jsonl` 历史条目 (供 `@` 引用与 `session/load` 兜底)。
pub fn read_agy_transcript_entries(session_id: &str) -> Vec<Value> {
    match agy_transcript_path(session_id) {
        Some(p) => read_agy_transcript_entries_from(&p),
        None => Vec::new(),
    }
}

/// 从 `transcript.jsonl` 提取历史会话累计 token 与末次上下文占用。
#[derive(Debug, Clone, Default)]
pub struct AgyTranscriptStats {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub last_context_tokens: Option<u64>,
    pub user_messages: u64,
    pub assistant_messages: u64,
}

pub fn read_agy_transcript_stats_from(path: &Path) -> AgyTranscriptStats {
    let Ok(file) = std::fs::File::open(path) else {
        return AgyTranscriptStats::default();
    };
    let reader = BufReader::new(file);
    let mut st = AgyTranscriptStats::default();
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|x| x.as_str()) {
            Some("USER_INPUT") => {
                st.user_messages += 1;
            }
            Some("PLANNER_RESPONSE") => {
                let inp = v.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                let out = v.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                let cr = v.get("cache_read_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                if inp > 0 || out > 0 || cr > 0 {
                    st.input_tokens += inp;
                    st.output_tokens += out;
                    st.cache_read_tokens += cr;
                    st.assistant_messages += 1;
                    let ctx = inp + cr;
                    if ctx > 0 {
                        st.last_context_tokens = Some(ctx);
                    }
                }
            }
            _ => {}
        }
    }
    st
}

pub fn read_agy_transcript_stats(session_id: &str) -> AgyTranscriptStats {
    match agy_transcript_path(session_id) {
        Some(p) => read_agy_transcript_stats_from(&p),
        None => AgyTranscriptStats::default(),
    }
}

/// 删除单个 AGY CLI 会话文件 (`conversations/<id>.db` 及 `-wal`/`-shm`), 并清理索引表记录。
pub fn delete_agy_session(path: &Path) -> Result<(), String> {
    let abs = ensure_within_agy_conversations(path)?;
    let session_id = abs
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    std::fs::remove_file(&abs).map_err(|e| format!("删除 Antigravity 会话文件失败: {e}"))?;
    let base = abs.to_string_lossy();
    let _ = std::fs::remove_file(format!("{base}-wal"));
    let _ = std::fs::remove_file(format!("{base}-shm"));

    if let (Some(sid), Ok(root)) = (session_id, antigravity_cli_dir()) {
        let summary_db = root.join("conversation_summaries.db");
        if summary_db.is_file() {
            if let Ok(conn) = Connection::open(&summary_db) {
                let _ = conn.busy_timeout(Duration::from_millis(500));
                let _ = conn.execute(
                    "DELETE FROM conversation_summaries WHERE conversation_id = ?1",
                    [sid],
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn decodes_agy_workspace_uris_to_native_paths() {
        assert_eq!(
            decode_file_uri_to_path("file:///c%3A/workspace/hanjiang/pi-kitsune-desktop").as_deref(),
            Some(r"C:\workspace\hanjiang\pi-kitsune-desktop")
        );
        assert_eq!(
            decode_file_uri_to_path("file:///C:/workspace/bin/").as_deref(),
            Some(r"C:\workspace\bin")
        );
        assert_eq!(
            decode_file_uri_to_path("/c:/workspace/demo").as_deref(),
            Some(r"C:\workspace\demo")
        );
        assert_eq!(
            decode_file_uri_to_path("file:///c%3A/Users/%E6%B1%89%E6%B1%9F/proj").as_deref(),
            Some(r"C:\Users\汉江\proj")
        );
        assert_eq!(
            decode_file_uri_to_path("file:///home/user/repo").as_deref(),
            Some("/home/user/repo")
        );
    }

    #[test]
    fn lists_only_non_empty_antigravity_cli_sessions_from_sqlite() {
        let dir = std::env::temp_dir().join(format!(
            "kitsune-agy-hist-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let convs = dir.join("conversations");
        std::fs::create_dir_all(&convs).unwrap();
        std::fs::write(convs.join("cli-1.db"), b"stub").unwrap();
        std::fs::write(convs.join("cli-empty.db"), b"stub").unwrap();
        std::fs::write(convs.join("ide-1.db"), b"stub").unwrap();

        let db_path = dir.join("conversation_summaries.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE conversation_summaries (
                conversation_id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                preview TEXT NOT NULL DEFAULT '',
                step_count INTEGER NOT NULL DEFAULT 0,
                last_modified_time TEXT NOT NULL DEFAULT '',
                workspace_uris TEXT NOT NULL DEFAULT '',
                app_data_dir TEXT NOT NULL DEFAULT ''
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversation_summaries VALUES
             ('cli-1', 'Fix Bug', 'preview 1', 4, '2026-11-21 15:25:28.123+00:00', '[\"file:///c%3A/workspace/proj\"]', 'antigravity-cli'),
             ('cli-empty', '', '', 0, '0001-01-01 00:00:00+00:00', '[\"file:///c:/workspace/proj\"]', 'antigravity-cli'),
             ('ide-1', 'IDE Session', 'ide', 10, '2026-11-21 16:00:00+00:00', '[\"file:///c:/workspace/proj\"]', 'antigravity')",
            [],
        )
        .unwrap();
        drop(conn);

        let list = list_agy_sessions_from(&db_path, &convs);
        assert_eq!(list.len(), 1);
        let (cwd, info) = &list[0];
        assert_eq!(cwd, r"C:\workspace\proj");
        assert_eq!(info.session_id, "cli-1");
        assert_eq!(info.preview, "Fix Bug");
        assert_eq!(info.agent_kind, AgentKind::Agy);
        assert_eq!(info.timestamp, "2026-11-21T15:25:28Z");
        assert!(info.session_path.ends_with("cli-1.db"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_agy_transcript_entries_and_stats() {
        let dir = std::env::temp_dir().join(format!(
            "kitsune-agy-tr-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("transcript.jsonl");
        let mut fp = std::fs::File::create(&file).unwrap();
        writeln!(
            fp,
            r#"{{"step_index":0,"type":"USER_INPUT","created_at":"2026-11-21T10:00:00Z","content":"<USER_REQUEST>\n你好 AGY\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"}}"#
        ).unwrap();
        writeln!(
            fp,
            r#"{{"step_index":1,"type":"PLANNER_RESPONSE","created_at":"2026-11-21T10:00:02Z","model":"gemini-4-neon-high","input_tokens":12000,"cache_read_tokens":500,"output_tokens":80,"thinking":"想一下","content":"你好！"}}"#
        ).unwrap();
        drop(fp);

        let entries = read_agy_transcript_entries_from(&file);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["message"]["role"], "user");
        assert_eq!(entries[0]["message"]["content"][0]["text"], "你好 AGY");
        assert_eq!(entries[1]["message"]["role"], "assistant");
        assert_eq!(entries[1]["message"]["content"][0]["type"], "thinking");
        assert_eq!(entries[1]["message"]["content"][1]["text"], "你好！");

        let stats = read_agy_transcript_stats_from(&file);
        assert_eq!(stats.user_messages, 1);
        assert_eq!(stats.assistant_messages, 1);
        assert_eq!(stats.input_tokens, 12000);
        assert_eq!(stats.cache_read_tokens, 500);
        assert_eq!(stats.output_tokens, 80);
        assert_eq!(stats.last_context_tokens, Some(12500));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
