//! Codex CLI 本地历史会话数据源 (`$CODEX_HOME` / `~/.codex/`):
//! - 只读扫描最新编号的 `state_*.sqlite` (`threads` 表)，过滤归档与 subagent 线程
//! - 去除 Windows verbatim 前缀 (`\\?\`) 归一化 `cwd` 与 `rollout_path`
//! - 优先从 `thread_history_*.sqlite` (`thread_items` 表) 毫秒级还原历史条目，兼容已被压缩为 `.jsonl.zst` 的旧会话
//! - 未投影到 `thread_history_*.sqlite` 的全新 `.jsonl` 线程兜底解析 rollout 文件
//! - 路径边界校验与安全删除 (同步清理 rollout 文件与 SQLite 索引)

use crate::backends::codex::protocol::{
    response_items_to_entries, sanitize_response_item_for_migration, thread_items_to_entries,
};
use crate::backends::AgentKind;
use crate::session_fs::SessionInfo;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `$CODEX_HOME` 或默认 `~/.codex` 根目录。
pub fn codex_home_dir() -> Result<PathBuf, String> {
    if let Ok(env_dir) = std::env::var("CODEX_HOME") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法确定用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".codex"))
}

/// `$CODEX_HOME/sessions` 目录。
pub fn codex_sessions_dir() -> Result<PathBuf, String> {
    Ok(codex_home_dir()?.join("sessions"))
}

/// 剥离 Windows `\\?\` verbatim 路径前缀并去除末尾多余分隔符。
pub fn strip_verbatim_prefix(raw: &str) -> String {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| trimmed.strip_prefix(r"\\?\").map(|s| s.to_string()))
        .unwrap_or_else(|| trimmed.to_string());
    let cleaned = stripped.trim_end_matches(['\\', '/']);
    if cleaned.len() == 2 && cleaned.ends_with(':') {
        format!("{cleaned}\\")
    } else {
        cleaned.to_string()
    }
}

fn is_safe_thread_id(id: &str) -> bool {
    let s = id.trim();
    !s.is_empty()
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains("..")
        && !s.contains('\0')
}

/// 查找目录中版本号最高的 `<prefix><N>.sqlite` (如 `state_5.sqlite` / `thread_history_1.sqlite`)。
fn find_latest_versioned_sqlite(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(prefix) else {
            continue;
        };
        let Some(num_str) = rest.strip_suffix(".sqlite") else {
            continue;
        };
        let Ok(ver) = num_str.parse::<u64>() else {
            continue;
        };
        if best.as_ref().is_none_or(|(b, _)| ver > *b) {
            best = Some((ver, p));
        }
    }
    best.map(|(_, p)| p)
}

/// 从 `rollout-2026-11-24T11-17-13-<uuid>.jsonl[.zst]` 或裸 `<uuid>` 提取 Codex `threadId`。
pub fn extract_codex_thread_id(path_or_id: &str) -> Option<String> {
    let cleaned = strip_verbatim_prefix(path_or_id);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }

    if !trimmed.contains('\\') && !trimmed.contains('/') && !trimmed.ends_with(".jsonl") && !trimmed.ends_with(".zst") {
        return is_safe_thread_id(trimmed).then(|| trimmed.to_string());
    }

    let file_name = Path::new(trimmed).file_name()?.to_str()?;
    let stem = file_name
        .strip_suffix(".jsonl.zst")
        .or_else(|| file_name.strip_suffix(".jsonl"))
        .or_else(|| file_name.strip_suffix(".zst"))
        .unwrap_or(file_name);

    // 标准文件名: rollout-YYYY-MM-DDTHH-MM-SS-<uuid36>
    if let Some(rest) = stem.strip_prefix("rollout-") {
        // UUID 为最后 36 字符 (8-4-4-4-12)
        if rest.len() >= 36 {
            let candidate = &rest[rest.len() - 36..];
            if candidate.bytes().filter(|&b| b == b'-').count() == 4 && is_safe_thread_id(candidate) {
                return Some(candidate.to_string());
            }
        }
    }

    is_safe_thread_id(stem).then(|| stem.to_string())
}

/// 路径安全校验: 确认目标会话路径位于 `$CODEX_HOME/sessions/` 根内。
/// 兼容旧会话已由 Codex 压缩为 `.jsonl.zst` 的情况 (入参可能仍是索引记录的 `.jsonl` 路径)。
pub fn ensure_within_codex_sessions(path: &Path) -> Result<PathBuf, String> {
    let root = codex_sessions_dir()?;
    let root_canon = root.canonicalize().unwrap_or(root);
    let plain = PathBuf::from(strip_verbatim_prefix(&path.to_string_lossy()));

    let candidate = if plain.is_file() {
        plain.canonicalize().map_err(|e| format!("Codex 会话文件不存在: {e}"))?
    } else {
        let zst = PathBuf::from(format!("{}.zst", plain.to_string_lossy()));
        if zst.is_file() {
            zst.canonicalize().map_err(|e| format!("Codex 会话文件不存在: {e}"))?
        } else if let Some(parent) = plain.parent() {
            let parent_canon = parent
                .canonicalize()
                .map_err(|e| format!("Codex 会话目录不存在: {e}"))?;
            let fname = plain
                .file_name()
                .ok_or_else(|| "无效的 Codex 会话路径".to_string())?;
            parent_canon.join(fname)
        } else {
            return Err("无效的 Codex 会话路径".into());
        }
    };

    if !candidate.starts_with(&root_canon) {
        return Err("拒绝访问非 Codex 会话目录内的文件".into());
    }
    Ok(candidate)
}

fn epoch_ms_to_iso_utc(ms: u64) -> String {
    let total_secs = (ms / 1000) as i64;
    let days = total_secs.div_euclid(86_400);
    let rem = total_secs.rem_euclid(86_400);
    let h = rem / 3_600;
    let mi = (rem % 3_600) / 60;
    let se = rem % 60;
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{se:02}Z")
}

/// 从指定 `state_*.sqlite` 读取全部非归档、非 subagent 的 Codex 会话。
fn list_codex_sessions_from(state_db: &Path, sessions_dir: &Path) -> Vec<(String, SessionInfo)> {
    if !state_db.is_file() {
        return Vec::new();
    }
    let Ok(conn) = Connection::open_with_flags(
        state_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let _ = conn.busy_timeout(Duration::from_millis(200));

    // 兼容不同版本 state_*.sqlite: 探测可选列 (updated_at_ms / name / preview)
    let mut cols: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(mut pragma) = conn.prepare("PRAGMA table_info(threads)") {
        if let Ok(rows) = pragma.query_map([], |row| row.get::<_, String>(1)) {
            for c in rows.flatten() {
                cols.insert(c);
            }
        }
    }
    let has_name = cols.contains("name");
    let has_preview = cols.contains("preview");
    let has_updated_ms = cols.contains("updated_at_ms");

    let sql = format!(
        "SELECT id, rollout_path, cwd, title, updated_at, source, {name_expr}, {preview_expr}, {upd_ms_expr} \
         FROM threads \
         WHERE COALESCE(archived, 0) = 0 \
         ORDER BY COALESCE({upd_ms_order}, updated_at * 1000) DESC",
        name_expr = if has_name { "COALESCE(name, '')" } else { "''" },
        preview_expr = if has_preview { "COALESCE(preview, '')" } else { "''" },
        upd_ms_expr = if has_updated_ms { "updated_at_ms" } else { "NULL" },
        upd_ms_order = if has_updated_ms { "updated_at_ms" } else { "updated_at * 1000" },
    );

    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };

    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1).unwrap_or_default(),
            row.get::<_, String>(2).unwrap_or_default(),
            row.get::<_, String>(3).unwrap_or_default(),
            row.get::<_, i64>(4).unwrap_or(0),
            row.get::<_, String>(5).unwrap_or_default(),
            row.get::<_, String>(6).unwrap_or_default(),
            row.get::<_, String>(7).unwrap_or_default(),
            row.get::<_, Option<i64>>(8).unwrap_or(None),
        ))
    }) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for row in rows.flatten() {
        let (id, raw_rollout, raw_cwd, title, updated_at, source, name, preview_col, updated_ms) =
            row;
        if !is_safe_thread_id(&id) {
            continue;
        }
        // 排除 Codex 内部 subagent / guardian 派生线程
        if source.trim_start().starts_with('{') && source.contains("\"subagent\"") {
            continue;
        }
        let cwd = strip_verbatim_prefix(&raw_cwd);
        if cwd.is_empty() {
            continue;
        }

        let chosen_title = [name.trim(), title.trim(), preview_col.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("");
        if chosen_title.is_empty() {
            continue;
        }
        let preview: String = chosen_title.chars().take(120).collect();

        let normalized_rollout = strip_verbatim_prefix(&raw_rollout);
        let session_path = if !normalized_rollout.is_empty() {
            normalized_rollout
        } else {
            sessions_dir
                .join(format!("{id}.jsonl"))
                .to_string_lossy()
                .to_string()
        };
        let file_name = Path::new(&session_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{id}.jsonl"));

        let mtime_ms = updated_ms
            .filter(|&v| v > 0)
            .map(|v| v as u64)
            .or_else(|| (updated_at > 0).then_some(updated_at as u64 * 1000));
        let timestamp = mtime_ms.map(epoch_ms_to_iso_utc).unwrap_or_default();

        out.push((
            cwd,
            SessionInfo {
                file_name,
                session_path,
                timestamp,
                session_id: id,
                preview,
                mtime_ms,
                agent_kind: AgentKind::Codex,
            },
        ));
    }
    out
}

/// 扫描本机 `$CODEX_HOME/state_*.sqlite` 中所有主 Codex 会话。
pub fn list_codex_sessions() -> Vec<(String, SessionInfo)> {
    let Ok(home) = codex_home_dir() else {
        return Vec::new();
    };
    let Some(state_db) = find_latest_versioned_sqlite(&home, "state_") else {
        return Vec::new();
    };
    list_codex_sessions_from(&state_db, &home.join("sessions"))
}

/// 从指定 `thread_history_*.sqlite` 读取某个线程的全部 `thread_items` 并转为标准历史条目。
fn read_entries_from_history_db(db_path: &Path, thread_id: &str) -> Vec<Value> {
    if !db_path.is_file() || !is_safe_thread_id(thread_id) {
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
        "SELECT item_json, created_at_ms \
         FROM thread_items \
         WHERE thread_id = ?1 \
         ORDER BY rollout_ordinal ASC, rowid ASC",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([thread_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<i64>>(1).unwrap_or(None),
        ))
    }) else {
        return Vec::new();
    };

    let mut items = Vec::new();
    for row in rows.flatten() {
        let (json_str, created_ms) = row;
        if let Ok(val) = serde_json::from_str::<Value>(&json_str) {
            let ts = created_ms
                .filter(|&v| v > 0)
                .map(|v| epoch_ms_to_iso_utc(v as u64));
            items.push((val, ts));
        }
    }
    thread_items_to_entries(&items)
}

/// 解压 Zstandard 字节流（兼容单帧及多帧拼接的 `.jsonl.zst`）。
fn decode_zstd_bytes(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut slice = raw;
    let mut out = Vec::new();
    while !slice.is_empty() {
        let before = slice.len();
        let mut decoder = ruzstd::decoding::StreamingDecoder::new(&mut slice)
            .map_err(|e| format!("初始化 zstd 解码器失败: {e}"))?;
        decoder
            .read_to_end(&mut out)
            .map_err(|e| format!("解压 .jsonl.zst 失败: {e}"))?;
        if slice.len() == before {
            break;
        }
    }
    Ok(out)
}

/// 解析目标 rollout 文件的实际磁盘路径（自动兼容传入 `.jsonl` 但磁盘已压缩为 `.jsonl.zst` 的情况）。
fn resolve_existing_rollout_file(path: &Path) -> Option<PathBuf> {
    let plain = PathBuf::from(strip_verbatim_prefix(&path.to_string_lossy()));
    if plain.is_file() {
        return Some(plain);
    }
    let s = plain.to_string_lossy();
    if !s.ends_with(".zst") {
        let zst = PathBuf::from(format!("{s}.zst"));
        if zst.is_file() {
            return Some(zst);
        }
    }
    None
}

/// 读取 rollout 文件全文（自动兼容明文 `.jsonl` 与压缩 `.jsonl.zst`，严格只读不改写原文件）。
fn read_rollout_text(path: &Path) -> Result<String, String> {
    let actual = resolve_existing_rollout_file(path)
        .ok_or_else(|| format!("未找到 Codex 会话文件: {}", path.display()))?;
    let bytes = std::fs::read(&actual).map_err(|e| format!("读取会话文件失败: {e}"))?;
    let decoded = if actual
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zst"))
    {
        decode_zstd_bytes(&bytes)?
    } else {
        bytes
    };
    Ok(String::from_utf8_lossy(&decoded).into_owned())
}

/// 从 `state_*.sqlite` 查出指定 `thread_id` 的原始 `rollout_path` 与标题（供跨供应商迁移定位文件与继承标题）。
#[derive(Debug, Clone, Default)]
pub struct CodexThreadMeta {
    pub rollout_path: Option<String>,
    pub title: Option<String>,
}

pub fn lookup_codex_thread_meta(thread_id: &str) -> CodexThreadMeta {
    if !is_safe_thread_id(thread_id) {
        return CodexThreadMeta::default();
    }
    let Ok(home) = codex_home_dir() else {
        return CodexThreadMeta::default();
    };
    let Some(state_db) = find_latest_versioned_sqlite(&home, "state_") else {
        return CodexThreadMeta::default();
    };
    let Ok(conn) = Connection::open_with_flags(
        &state_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return CodexThreadMeta::default();
    };
    let _ = conn.busy_timeout(Duration::from_millis(200));

    let mut cols: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(mut pragma) = conn.prepare("PRAGMA table_info(threads)") {
        if let Ok(rows) = pragma.query_map([], |row| row.get::<_, String>(1)) {
            for c in rows.flatten() {
                cols.insert(c);
            }
        }
    }
    let name_expr = if cols.contains("name") {
        "COALESCE(name, '')"
    } else {
        "''"
    };
    let preview_expr = if cols.contains("preview") {
        "COALESCE(preview, '')"
    } else {
        "''"
    };
    let sql = format!(
        "SELECT COALESCE(rollout_path, ''), {name_expr}, COALESCE(title, ''), {preview_expr} \
         FROM threads WHERE id = ?1 LIMIT 1"
    );
    let Ok((raw_rp, name, title, preview)) = conn.query_row(&sql, [thread_id], |row| {
        Ok((
            row.get::<_, String>(0).unwrap_or_default(),
            row.get::<_, String>(1).unwrap_or_default(),
            row.get::<_, String>(2).unwrap_or_default(),
            row.get::<_, String>(3).unwrap_or_default(),
        ))
    }) else {
        return CodexThreadMeta::default();
    };

    let rollout_path = {
        let cleaned = strip_verbatim_prefix(&raw_rp);
        (!cleaned.is_empty()).then_some(cleaned)
    };
    let chosen_title = [name.trim(), title.trim(), preview.trim()]
        .into_iter()
        .find(|s| !s.is_empty())
        .map(|s| s.chars().take(120).collect());

    CodexThreadMeta {
        rollout_path,
        title: chosen_title,
    }
}

/// 从 rollout 文本提取并清洗用于跨供应商迁移的 `ResponseItem[]`（纯函数，便于单测）。
fn extract_migration_history_from_text(text: &str) -> Vec<Value> {
    let mut history = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) != Some("response_item") {
            continue;
        }
        if let Some(payload) = v.get("payload") {
            if let Some(cleaned) = sanitize_response_item_for_migration(payload) {
                history.push(cleaned);
            }
        }
    }
    history
}

/// 读取并清洗指定旧会话的完整 `ResponseItem[]` 历史，供跨供应商无损迁移（兼容 `.jsonl` 与 `.jsonl.zst`）。
pub fn load_codex_migration_history(
    thread_id: &str,
    rollout_path: Option<&Path>,
) -> Result<Vec<Value>, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = rollout_path {
        let cleaned = strip_verbatim_prefix(&p.to_string_lossy());
        if !cleaned.is_empty() {
            candidates.push(PathBuf::from(cleaned));
        }
    }
    if let Some(db_rp) = lookup_codex_thread_meta(thread_id).rollout_path {
        let pb = PathBuf::from(db_rp);
        if !candidates.iter().any(|c| c == &pb) {
            candidates.push(pb);
        }
    }

    let mut last_err = "未找到原会话的历史文件".to_string();
    for cand in candidates {
        match read_rollout_text(&cand) {
            Ok(text) => {
                let items = extract_migration_history_from_text(&text);
                if !items.is_empty() {
                    return Ok(items);
                }
                last_err = "原会话文件中未包含可迁移的历史消息".to_string();
            }
            Err(e) => {
                last_err = e;
            }
        }
    }
    Err(last_err)
}

/// 兜底解析 rollout `.jsonl` / `.jsonl.zst` 文件 (当 `thread_history_*.sqlite` 尚未落盘时)：
/// 优先解析 `event_msg(item_completed)`；若为空（例如经 `history` 参数迁移生成的新线程），
/// 回退解析 `response_item` 确保历史消息同样可完整渲染。
fn read_entries_from_rollout(path: &Path) -> Vec<Value> {
    let Ok(text) = read_rollout_text(path) else {
        return Vec::new();
    };
    let mut completed_items: Vec<(Value, Option<String>)> = Vec::new();
    let mut response_items: Vec<(Value, Option<String>)> = Vec::new();

    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        match v.get("type").and_then(|x| x.as_str()) {
            Some("event_msg") => {
                if let Some(payload) = v.get("payload") {
                    if payload.get("type").and_then(|x| x.as_str()) == Some("item_completed") {
                        if let Some(item) = payload.get("item") {
                            completed_items.push((item.clone(), ts));
                        }
                    }
                }
            }
            Some("response_item") => {
                if let Some(payload) = v.get("payload") {
                    response_items.push((payload.clone(), ts));
                }
            }
            _ => {}
        }
    }

    if !completed_items.is_empty() {
        return thread_items_to_entries(&completed_items);
    }
    if !response_items.is_empty() {
        return response_items_to_entries(&response_items);
    }
    Vec::new()
}

/// 读取指定 Codex 会话的标准历史条目 (优先 `thread_history_*.sqlite`, 兜底 `.jsonl` / `.jsonl.zst` rollout)。
pub fn read_codex_session_entries(thread_id: &str, rollout_path: Option<&Path>) -> Vec<Value> {
    if let Ok(home) = codex_home_dir() {
        if let Some(hist_db) = find_latest_versioned_sqlite(&home, "thread_history_") {
            let entries = read_entries_from_history_db(&hist_db, thread_id);
            if !entries.is_empty() {
                return entries;
            }
        }
    }
    if let Some(p) = rollout_path {
        let entries = read_entries_from_rollout(p);
        if !entries.is_empty() {
            return entries;
        }
    }
    Vec::new()
}

/// 删除单个 Codex 会话 (清理 `.jsonl` / `.jsonl.zst` 文件及 `state_*.sqlite` / `thread_history_*.sqlite` 记录)。
pub fn delete_codex_session(path: &Path) -> Result<(), String> {
    let abs = ensure_within_codex_sessions(path)?;
    let thread_id = extract_codex_thread_id(&abs.to_string_lossy());

    let plain_str = strip_verbatim_prefix(&abs.to_string_lossy());
    let base_jsonl = plain_str.strip_suffix(".zst").unwrap_or(&plain_str);
    let zst_path = format!("{base_jsonl}.zst");
    let _ = std::fs::remove_file(base_jsonl);
    let _ = std::fs::remove_file(&zst_path);

    if let (Some(tid), Ok(home)) = (thread_id, codex_home_dir()) {
        if let Some(state_db) = find_latest_versioned_sqlite(&home, "state_") {
            if let Ok(conn) = Connection::open(&state_db) {
                let _ = conn.busy_timeout(Duration::from_millis(500));
                let _ = conn.execute("DELETE FROM threads WHERE id = ?1", [&tid]);
            }
        }
        if let Some(hist_db) = find_latest_versioned_sqlite(&home, "thread_history_") {
            if let Ok(conn) = Connection::open(&hist_db) {
                let _ = conn.busy_timeout(Duration::from_millis(500));
                let _ = conn.execute("DELETE FROM thread_items WHERE thread_id = ?1", [&tid]);
                let _ = conn.execute("DELETE FROM thread_turns WHERE thread_id = ?1", [&tid]);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_windows_verbatim_prefix_and_extracts_thread_id() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\workspace\ZhiKuYun\drgs"),
            r"C:\workspace\ZhiKuYun\drgs"
        );
        assert_eq!(
            extract_codex_thread_id(
                r"\\?\C:\Users\u\.codex\sessions\2026\11\24\rollout-2026-11-24T11-17-13-01a20b8e-bd7e-7da0-99ef-4f8df96339ff.jsonl.zst"
            )
            .as_deref(),
            Some("01a20b8e-bd7e-7da0-99ef-4f8df96339ff")
        );
        assert_eq!(
            extract_codex_thread_id("01a20b8e-bd7e-7da0-99ef-4f8df96339ff").as_deref(),
            Some("01a20b8e-bd7e-7da0-99ef-4f8df96339ff")
        );
    }

    #[test]
    fn lists_codex_sessions_filtering_archived_and_subagents() {
        let dir = std::env::temp_dir().join(format!(
            "kitsune-codex-hist-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sessions = dir.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();

        let state_db = dir.join("state_5.sqlite");
        let conn = Connection::open(&state_db).unwrap();
        conn.execute(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL DEFAULT '',
                cwd TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL DEFAULT 0,
                updated_at_ms INTEGER,
                archived INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT '',
                name TEXT,
                preview TEXT
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads VALUES
             ('01a20b8e-bd7e-7da0-99ef-4f8df96339ff', '\\\\?\\C:\\Users\\u\\.codex\\sessions\\2026\\11\\24\\rollout-2026-11-24T11-17-13-01a20b8e-bd7e-7da0-99ef-4f8df96339ff.jsonl', '\\\\?\\C:\\workspace\\demo', '修复登录问题', 1795490479, 1795490479000, 0, 'cli', NULL, 'preview'),
             ('01a20b8e-0000-7da0-99ef-4f8df96339ff', '', 'C:\\workspace\\demo', '归档会话', 1795490479, 1795490479000, 1, 'cli', NULL, ''),
             ('01a20b8e-1111-7da0-99ef-4f8df96339ff', '', 'C:\\workspace\\demo', '子代理任务', 1795490479, 1795490479000, 0, '{\"subagent\":{\"other\":\"guardian\"}}', NULL, '')",
            [],
        )
        .unwrap();
        drop(conn);

        let list = list_codex_sessions_from(&state_db, &sessions);
        assert_eq!(list.len(), 1);
        let (cwd, info) = &list[0];
        assert_eq!(cwd, r"C:\workspace\demo");
        assert_eq!(info.agent_kind, AgentKind::Codex);
        assert_eq!(info.preview, "修复登录问题");
        assert_eq!(info.session_id, "01a20b8e-bd7e-7da0-99ef-4f8df96339ff");
        assert!(!info.session_path.starts_with(r"\\?\"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_entries_from_thread_history_sqlite() {
        let dir = std::env::temp_dir().join(format!(
            "kitsune-codex-items-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("thread_history_1.sqlite");
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "CREATE TABLE thread_items (
                thread_id TEXT NOT NULL,
                rollout_ordinal INTEGER NOT NULL,
                created_at_ms INTEGER,
                item_json TEXT NOT NULL
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO thread_items VALUES
             ('tid-1', 1, 1795490000000, '{\"type\":\"userMessage\",\"id\":\"u1\",\"content\":[{\"type\":\"text\",\"text\":\"hi codex\"}]}'),
             ('tid-1', 2, 1795490001000, '{\"type\":\"agentMessage\",\"id\":\"a1\",\"text\":\"hello!\"}')",
            [],
        )
        .unwrap();
        drop(conn);

        let entries = read_entries_from_history_db(&db, "tid-1");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["message"]["role"], "user");
        assert_eq!(entries[0]["message"]["content"][0]["text"], "hi codex");
        assert_eq!(entries[1]["message"]["role"], "assistant");
        assert_eq!(entries[1]["message"]["content"][0]["text"], "hello!");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 构造一个 RFC 8878 合法单帧 Raw Block Zstandard 字节流（零外部压缩库依赖，用于单测）。
    fn encode_zstd_raw_frame(payload: &[u8]) -> Vec<u8> {
        assert!(payload.len() < 256);
        let mut out = Vec::with_capacity(9 + payload.len());
        // Magic Number (LE): 0xFD2FB528
        out.extend_from_slice(&[0x28, 0xB5, 0x2F, 0xFD]);
        // Frame Header Descriptor: Single_Segment=1 (0x20), FCS_Field_Size=0 (1 byte)
        out.push(0x20);
        // Frame_Content_Size (1 byte)
        out.push(payload.len() as u8);
        // Block_Header (3 bytes LE): Last_Block=1, Block_Type=0 (Raw), Block_Size=payload.len()
        let bh: u32 = 1 | ((payload.len() as u32) << 3);
        out.push((bh & 0xFF) as u8);
        out.push(((bh >> 8) & 0xFF) as u8);
        out.push(((bh >> 16) & 0xFF) as u8);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn loads_and_sanitizes_migration_history_from_zst_and_plain_rollout() {
        let dir = std::env::temp_dir().join(format!(
            "kitsune-codex-zst-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let line1 = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}"#;
        let line2 = r#"{"type":"response_item","payload":{"type":"reasoning","summary":[],"encrypted_content":"secret"}}"#;
        let combined = format!("{line1}\n{line2}\n");

        // 传入 `.jsonl` 路径但磁盘仅存在 `.jsonl.zst` → 自动解压并清洗
        let logical_jsonl = dir.join("rollout-test.jsonl");
        let zst_file = dir.join("rollout-test.jsonl.zst");
        std::fs::write(&zst_file, encode_zstd_raw_frame(combined.as_bytes())).unwrap();

        let history = load_codex_migration_history("tid-zst", Some(&logical_jsonl)).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["role"], "user");

        // read_entries_from_rollout 同样支持 `.jsonl.zst` 并能从 response_item 回退渲染
        let entries = read_entries_from_rollout(&logical_jsonl);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["message"]["role"], "user");
        assert_eq!(entries[0]["message"]["content"][0]["text"], "hi");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "实机验证: 解压并清洗本机 ~/.codex 中真实已压缩 .jsonl.zst 历史会话"]
    fn reads_real_codex_zst_rollout_for_migration() {
        let sessions = list_codex_sessions();
        let zst_sess = sessions
            .into_iter()
            .find(|(_, info)| PathBuf::from(format!("{}.zst", info.session_path)).is_file())
            .expect("expected at least one .jsonl.zst session on this machine");
        let items = load_codex_migration_history(
            &zst_sess.1.session_id,
            Some(Path::new(&zst_sess.1.session_path)),
        )
        .expect("should load and sanitize real .jsonl.zst session");
        assert!(!items.is_empty(), "expected non-empty sanitized items");
    }
}
