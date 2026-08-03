// 跨会话 token 聚合统计: 纯文件扫描 ~/.pi/agent/sessions/, 零 pi 进程依赖
// 数据源: 每条 assistant message 自带 usage (pi 原生 / OpenAI 兼容双格式)
//         + provider/model/timestamp; 项目路径 (cwd) 在文件首行 session 头

use serde_json::Value;
use std::path::{Path, PathBuf};

/// 规范化后的单条消息用量记录
struct UsageRecord {
    timestamp: String, // 消息 ISO 时间戳 (UTC, 字典序可比)
    provider: String,
    model: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total: u64,
    cost: f64,
}

/// usage 双格式解析:
/// - pi 原生: {input, output, cacheRead, cacheWrite, totalTokens, cost:{total}}
/// - OpenAI 兼容: {prompt_tokens, completion_tokens, total_tokens} (无 cost, 记 0)
/// 未知结构返回 None (该行跳过)
fn parse_usage(v: &Value) -> Option<(u64, u64, u64, u64, u64, f64)> {
    let num = |key: &str| v.get(key).and_then(|x| x.as_u64());
    if let (Some(input), Some(output), Some(total)) = (num("input"), num("output"), num("totalTokens")) {
        let cache_read = num("cacheRead").unwrap_or(0);
        let cache_write = num("cacheWrite").unwrap_or(0);
        let cost = v
            .get("cost")
            .and_then(|c| c.get("total"))
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0);
        Some((input, output, cache_read, cache_write, total, cost))
    } else if let (Some(prompt), Some(completion)) = (num("prompt_tokens"), num("completion_tokens")) {
        let total = num("total_tokens").unwrap_or(prompt + completion);
        Some((prompt, completion, 0, 0, total, 0.0))
    } else {
        None
    }
}

/// 递归收集目录下所有 *.jsonl (会话文件可能在顶层, 也可能在嵌套 run 目录)
fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// 扫描单个会话文件: 解析 session 头 (id + cwd) + 收集所有 assistant message 的用量
/// 返回 (session_id, cwd, 记录列表) — cwd 为空表示文件不可读/无 session 头
fn scan_session_file(path: &Path) -> (String, String, Vec<UsageRecord>) {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else {
        return (String::new(), String::new(), Vec::new());
    };
    let reader = std::io::BufReader::new(file);
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut records: Vec<UsageRecord> = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            // session 头: id + 项目路径的权威来源 (目录名是 pi 有损编码, 不可信)
            Some("session") => {
                session_id = v
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .to_string();
                cwd = v
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            // 只统计 assistant 消息的 usage; user/toolResult 无 usage 字段
            Some("message") => {
                let msg = v.get("message");
                let is_assistant = msg.and_then(|m| m.get("role")).and_then(|r| r.as_str()) == Some("assistant");
                // usage / provider / model 都在 message 对象内部 (顶层兜底)
                let usage = msg.and_then(|m| m.get("usage")).or_else(|| v.get("usage"));
                let Some(usage) = usage else { continue };
                let Some((input, output, cache_read, cache_write, total, cost)) = parse_usage(usage) else {
                    continue;
                };
                if !is_assistant || total == 0 {
                    continue;
                }
                let timestamp = v
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                // provider/model 在 message 对象内部 (顶层兜底)
                let get_str = |v: &Value, key: &str| {
                    v.get("message")
                        .and_then(|m| m.get(key))
                        .and_then(|x| x.as_str())
                        .or_else(|| v.get(key).and_then(|x| x.as_str()))
                        .unwrap_or("")
                        .to_string()
                };
                records.push(UsageRecord {
                    timestamp,
                    provider: get_str(&v, "provider"),
                    model: get_str(&v, "model"),
                    input,
                    output,
                    cache_read,
                    cache_write,
                    total,
                    cost,
                });
            }
            _ => {}
        }
    }
    (session_id, cwd, records)
}

/// 单条消息是否通过过滤条件
/// 时间区间用完整 ISO 字符串字典序比较 (约定: start 取当天零点, end 取次日零点, 两端都含)
/// project 是文件级字段 (session 头 cwd), 由调用方传入
fn record_passes(
    r: &UsageRecord,
    start_time: Option<&str>,
    end_time: Option<&str>,
    provider: Option<&str>,
    model: Option<&str>,
) -> bool {
    if let Some(s) = start_time {
        if r.timestamp.as_str() < s {
            return false;
        }
    }
    if let Some(e) = end_time {
        if r.timestamp.as_str() > e {
            return false;
        }
    }
    if let Some(p) = provider {
        if !r.provider.eq_ignore_ascii_case(p) {
            return false;
        }
    }
    if let Some(m) = model {
        if !r.model.eq_ignore_ascii_case(m) {
            return false;
        }
    }
    true
}

/// 会话级聚合 (一个 jsonl 文件 = 一个会话): 明细行的数据源
struct SessionAgg {
    session_id: String,
    file_name: String,
    project: String,
    provider: String, // 最后一条匹配消息的 provider/model (会话内顺序覆盖)
    model: String,
    timestamp: String, // 最后一条匹配消息的时间 (倒序排序用)
    msg_count: u64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total: u64,
    cost: f64,
}

#[tauri::command]
pub fn get_token_stats(
    start_time: Option<String>,
    end_time: Option<String>,
    project: Option<String>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<Value, String> {
    let sessions_root = crate::session_fs::agent_dir()?.join("sessions");
    let start = start_time.as_deref();
    let end = end_time.as_deref();
    let proj = project.as_deref();
    let prov = provider.as_deref();
    let mdl = model.as_deref();

    // 全量筛选项 (不过滤, 供前端下拉): 扫描时顺便收集
    let mut filter_projects = std::collections::BTreeSet::new();
    let mut filter_providers = std::collections::BTreeSet::new();
    let mut filter_models = std::collections::BTreeSet::new();

    // 汇总与按天聚合
    let mut total = SessionAgg {
        session_id: String::new(),
        file_name: String::new(),
        project: String::new(),
        provider: String::new(),
        model: String::new(),
        timestamp: String::new(),
        msg_count: 0,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        total: 0,
        cost: 0.0,
    };
    let mut by_day: std::collections::BTreeMap<String, (u64, u64, u64, u64, u64, f64, u64)> =
        std::collections::BTreeMap::new();
    let mut sessions: Vec<SessionAgg> = Vec::new();

    let mut files = Vec::new();
    collect_jsonl_files(&sessions_root, &mut files);
    for path in &files {
        let (session_id, cwd, records) = scan_session_file(path);
        if cwd.is_empty() {
            continue; // 无 session 头的文件跳过
        }
        // 筛选项收集 (全量, 不随过滤收缩): 文件级 cwd + 消息级 provider/model
        filter_projects.insert(cwd.clone());
        for r in &records {
            if !r.provider.is_empty() {
                filter_providers.insert(r.provider.clone());
            }
            if !r.model.is_empty() {
                filter_models.insert(r.model.clone());
            }
        }
        // 项目过滤: 文件级 (cwd 不匹配则整个会话跳过)
        if let Some(p) = proj {
            if !cwd.eq_ignore_ascii_case(p) {
                continue;
            }
        }
        let mut agg = SessionAgg {
            session_id,
            file_name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            project: cwd.clone(),
            provider: String::new(),
            model: String::new(),
            timestamp: String::new(),
            msg_count: 0,
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            total: 0,
            cost: 0.0,
        };
        let mut file_has_usage = false;
        for r in &records {
            if !record_passes(r, start, end, prov, mdl) {
                continue;
            }
            file_has_usage = true;
            agg.input += r.input;
            agg.output += r.output;
            agg.cache_read += r.cache_read;
            agg.cache_write += r.cache_write;
            agg.total += r.total;
            agg.cost += r.cost;
            agg.msg_count += 1;
            if !r.provider.is_empty() {
                agg.provider = r.provider.clone();
            }
            if !r.model.is_empty() {
                agg.model = r.model.clone();
            }
            if !r.timestamp.is_empty() {
                agg.timestamp = r.timestamp.clone();
                // 按天: 消息 timestamp 前 10 字符 = UTC 日期
                let day = r.timestamp[..r.timestamp.len().min(10)].to_string();
                let e = by_day.entry(day).or_insert((0, 0, 0, 0, 0, 0.0, 0));
                e.0 += r.input;
                e.1 += r.output;
                e.2 += r.cache_read;
                e.3 += r.cache_write;
                e.4 += r.total;
                e.5 += r.cost;
                e.6 += 1;
            }
        }
        if file_has_usage {
            total.input += agg.input;
            total.output += agg.output;
            total.cache_read += agg.cache_read;
            total.cache_write += agg.cache_write;
            total.total += agg.total;
            total.cost += agg.cost;
            total.msg_count += agg.msg_count;
            sessions.push(agg);
        }
    }
    // 明细按时间倒序 (最新会话在前)
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    Ok(serde_json::json!({
        "summary": {
            "input": total.input, "output": total.output,
            "cacheRead": total.cache_read, "cacheWrite": total.cache_write,
            "total": total.total, "cost": total.cost,
            "messageCount": total.msg_count, "sessionCount": sessions.len(),
        },
        "byDay": by_day.into_iter().map(|(date, (i, o, cr, cw, t, c, mc))| {
            serde_json::json!({ "date": date, "input": i, "output": o,
                "cacheRead": cr, "cacheWrite": cw, "total": t, "cost": c, "messageCount": mc })
        }).collect::<Vec<_>>(),
        "sessions": sessions.into_iter().map(|s| {
            serde_json::json!({
                "sessionId": s.session_id, "fileName": s.file_name,
                "project": s.project, "provider": s.provider, "model": s.model,
                "timestamp": s.timestamp, "messageCount": s.msg_count,
                "input": s.input, "output": s.output,
                "cacheRead": s.cache_read, "cacheWrite": s.cache_write,
                "total": s.total, "cost": s.cost,
            })
        }).collect::<Vec<_>>(),
        "filters": {
            "projects": filter_projects.into_iter().collect::<Vec<_>>(),
            "providers": filter_providers.into_iter().collect::<Vec<_>>(),
            "models": filter_models.into_iter().collect::<Vec<_>>(),
        },
    }))
}
