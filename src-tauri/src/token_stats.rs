// 跨会话 token 聚合统计: 增量索引 + 内存缓存 (替代查询时全量扫描)
//
// 旧实现每次 get_token_stats 都全量递归扫描 ~/.pi/agent/sessions/ 并逐行构建
// JSON DOM (449 文件 / 214MB, 体感 1.5~4s)。新实现:
//   - 解析与查询解耦: 索引常驻内存, 查询只读内存聚合结果
//   - 增量守卫: 每文件记录 (mtime 纳秒, size), 未变文件 O(1) 跳过, 只重扫变化的
//   - 冷启动后台预热: lib.rs setup 里 spawn 线程建索引, 首次打开面板通常已就绪
//
// 数据源: 每条 assistant message 自带 usage (pi 原生 / OpenAI 兼容双格式)
//         + provider/model/timestamp; 项目路径 (cwd) 在文件首行 session 头

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 按日聚合累加器: (input, output, cache_read, cache_write, total, cost, msg_count)
type DayAgg = (u64, u64, u64, u64, u64, f64, u64);

/// 按天桶: 聚合值 + 桶内最后一条消息的展示信息
/// 明细行需要还原旧实现「最后一条匹配消息」的展示 (含时间过滤后的选取), 桶内
/// 必须保留 last_* 信息, 否则跨天会话按历史日期过滤时展示行会指向被过滤掉的消息
#[derive(Default)]
struct DayBucket {
    agg: DayAgg,
    last_ts: String,
    last_provider: String,
    last_provider_ts: String,
    last_model: String,
    last_model_ts: String,
}

/// (provider, model) 键下的子聚合: 一条 assistant 消息归入其 (provider, model) 组合
/// 这样 provider/model 过滤可以在查询时精确还原消息级口径, 而不必保留逐条记录
#[derive(Default)]
struct SubAgg {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total: u64,
    cost: f64,
    msg_count: u64,
    /// 该组合最后一条消息的 timestamp/provider/model (明细行展示 + 倒序排序用)
    last_timestamp: String,
    last_provider: String,
    last_model: String,
    /// 组合内最后一条非空 provider/model 消息的时间戳 (无时间过滤时选展示行用)
    last_provider_ts: String,
    last_model_ts: String,
    /// 按天桶 (消息 timestamp 前 10 字符 = UTC 日期); 时间过滤 = 桶级过滤
    by_day: BTreeMap<String, DayBucket>,
}

/// 单文件聚合快照 (一个 jsonl = 一个会话)
struct FileAgg {
    /// 增量守卫: 两者任一不匹配即触发该文件重扫 (append-only 场景 mtime 必变,
    /// size 兜底防 mtime 粒度/时钟异常)
    mtime_nanos: i128,
    size_bytes: u64,
    /// 文件级信息 (session 头权威来源)
    cwd: String,
    file_name: String,
    session_id: String,
    sub: BTreeMap<(String, String), SubAgg>,
}

/// 全局索引: 只增改删, 查询时全量 fold (几百条记录, 微秒级)
struct TokenIndex {
    files: BTreeMap<PathBuf, FileAgg>,
}

static TOKEN_INDEX: OnceLock<Mutex<TokenIndex>> = OnceLock::new();

fn token_index() -> &'static Mutex<TokenIndex> {
    TOKEN_INDEX.get_or_init(|| Mutex::new(TokenIndex { files: BTreeMap::new() }))
}

/// usage 双格式解析:
/// - pi 原生: {input, output, cacheRead, cacheWrite, totalTokens, cost:{total}}
/// - OpenAI 兼容: {prompt_tokens, completion_tokens, total_tokens} (无 cost, 记 0)
///
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

/// 扫描单个会话文件, 产出聚合快照; 无 session 头返回 None (该文件不入索引)
fn scan_file(path: &Path) -> Option<FileAgg> {
    use std::io::BufRead;
    let metadata = std::fs::metadata(path).ok()?;
    let mtime_nanos = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos() as i128;
    let size_bytes = metadata.len();
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut sub: BTreeMap<(String, String), SubAgg> = BTreeMap::new();
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
                let provider = get_str(&v, "provider");
                let model = get_str(&v, "model");
                // 归入 (provider, model) 子聚合; 空值归入 ("", ""), 无过滤时计入、按过滤时自然排除
                let e = sub.entry((provider.clone(), model.clone())).or_default();
                e.input += input;
                e.output += output;
                e.cache_read += cache_read;
                e.cache_write += cache_write;
                e.total += total;
                e.cost += cost;
                e.msg_count += 1;
                if !provider.is_empty() {
                    e.last_provider = provider;
                    e.last_provider_ts = timestamp.clone();
                }
                if !model.is_empty() {
                    e.last_model = model;
                    e.last_model_ts = timestamp.clone();
                }
                if !timestamp.is_empty() {
                    e.last_timestamp = timestamp.clone();
                    // 按天: 消息 timestamp 前 10 字符 = UTC 日期
                    let day = timestamp[..timestamp.len().min(10)].to_string();
                    let d = e.by_day.entry(day).or_default();
                    d.agg.0 += input;
                    d.agg.1 += output;
                    d.agg.2 += cache_read;
                    d.agg.3 += cache_write;
                    d.agg.4 += total;
                    d.agg.5 += cost;
                    d.agg.6 += 1;
                    // 桶内展示信息按行序覆盖 (最后一条优先)
                    d.last_ts = timestamp;
                    if !e.last_provider.is_empty() {
                        d.last_provider = e.last_provider.clone();
                        d.last_provider_ts = e.last_provider_ts.clone();
                    }
                    if !e.last_model.is_empty() {
                        d.last_model = e.last_model.clone();
                        d.last_model_ts = e.last_model_ts.clone();
                    }
                }
            }
            _ => {}
        }
    }
    if cwd.is_empty() {
        return None; // 无 session 头的文件跳过
    }
    Some(FileAgg {
        mtime_nanos,
        size_bytes,
        cwd,
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        session_id,
        sub,
    })
}

/// 递归收集目录下所有 *.jsonl 及元数据 (会话文件可能在顶层, 也可能在嵌套 run 目录)
/// 产出 (绝对路径 → (mtime 纳秒, size 字节)) 映射, 供增量比对
fn collect_files_with_meta(dir: &Path, out: &mut BTreeMap<PathBuf, (i128, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            collect_files_with_meta(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            // Windows 上 DirEntry::metadata 直接来自目录枚举数据, 零额外系统调用;
            // 用 path 再 stat 一次会为每个文件多发一次 syscall (449 文件可见量级差异)
            if let Ok(md) = entry.metadata() {
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos() as i128)
                    .unwrap_or(0);
                out.insert(path, (mtime, md.len()));
            }
        }
    }
}

/// 增量守卫: 磁盘枚举 + 与索引比对, 只重扫变化/新增/删除的文件
/// 未变文件 O(1) 跳过 (stat 数百文件为毫秒级); 重扫单文件 ~0.5MB, 偶发可接受
fn ensure_index() {
    let Ok(sessions_root) = crate::session_fs::agent_dir().map(|d| d.join("sessions")) else {
        return;
    };
    let mut disk: BTreeMap<PathBuf, (i128, u64)> = BTreeMap::new();
    collect_files_with_meta(&sessions_root, &mut disk);

    let mut guard = match token_index().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };

    // 已删除的文件: 从索引移除
    let stale: Vec<PathBuf> = guard.files.keys().filter(|k| !disk.contains_key(*k)).cloned().collect();
    for k in stale {
        guard.files.remove(&k);
    }
    // 新增/变化: (mtime, size) 任一不匹配 → 重扫替换; 扫描失败(无 session 头等) → 移除
    for (path, (mtime, size)) in &disk {
        let unchanged = matches!(guard.files.get(path), Some(f) if f.mtime_nanos == *mtime && f.size_bytes == *size);
        if unchanged {
            continue;
        }
        match scan_file(path) {
            Some(fa) => {
                guard.files.insert(path.clone(), fa);
            }
            None => {
                guard.files.remove(path);
            }
        }
    }
}

/// 冷启动预热: lib.rs setup 里后台线程调用 (进程内首次全量建索引, 1~2s)
pub fn prewarm() {
    ensure_index();
}

/// 会话删除联动: delete_session_file 成功后从索引移除, 避免残留导致统计虚高
pub fn remove_index_file(path: &Path) {
    if let Ok(mut guard) = token_index().lock() {
        guard.files.remove(path);
    }
}

/// 时间过滤 (天界): start 含当天零点, end 取次日零点 → 有效天 = [start_day, end_day)
/// 旧实现消息级比较会把「恰好 end 次日零点整点」的单条消息误含; 该消息语义上
/// 属于次日, 新口径整桶排除, 视为边界修正 (真实数据中零点整点写入概率≈0)
struct TimeFilter {
    start_day: Option<String>,
    end_day: Option<String>,
}

impl TimeFilter {
    fn none(&self) -> bool {
        self.start_day.is_none() && self.end_day.is_none()
    }

    fn day_in(&self, day: &str) -> bool {
        if let Some(s) = &self.start_day {
            if day < s.as_str() {
                return false;
            }
        }
        if let Some(e) = &self.end_day {
            if day >= e.as_str() {
                return false;
            }
        }
        true
    }
}

#[tauri::command]
pub fn get_token_stats(
    start_time: Option<String>,
    end_time: Option<String>,
    project: Option<String>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<Value, String> {
    // ISO 前 10 字符 = UTC 日期 (start 取当天零点所在日, end 取次日零点所在日)
    let tf = TimeFilter {
        start_day: start_time.as_deref().map(|s| s[..s.len().min(10)].to_string()),
        end_day: end_time.as_deref().map(|e| e[..e.len().min(10)].to_string()),
    };
    let proj = project.as_deref();
    let prov = provider.as_deref();
    let mdl = model.as_deref();

    // 增量守卫: 只重扫变化的文件; 之后查询走内存索引 (毫秒级)
    ensure_index();
    let guard = match token_index().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    Ok(aggregate(&guard, &tf, proj, prov, mdl))
}

/// 从内存索引按过滤条件聚合 (与旧实现消息级口径保持一致, 见 TimeFilter 注释)
fn aggregate(
    index: &TokenIndex,
    tf: &TimeFilter,
    proj: Option<&str>,
    prov: Option<&str>,
    mdl: Option<&str>,
) -> Value {
    // 汇总 (DayAgg 复用): total + by_day + 明细行 + 全量筛选集合
    let mut total: DayAgg = (0, 0, 0, 0, 0, 0.0, 0);
    let mut by_day: BTreeMap<String, DayAgg> = BTreeMap::new();
    let mut sessions: Vec<Value> = Vec::new();
    let mut filter_projects = BTreeSet::new();
    let mut filter_providers = BTreeSet::new();
    let mut filter_models = BTreeSet::new();

    for (_, fa) in &index.files {
        // 项目过滤: 文件级 (cwd 不匹配则整个会话跳过)
        filter_projects.insert(fa.cwd.clone());
        if let Some(p) = proj {
            if !fa.cwd.eq_ignore_ascii_case(p) {
                continue;
            }
        }
        let mut file_total: DayAgg = (0, 0, 0, 0, 0, 0.0, 0);
        // 明细行展示字段候选 (旧实现消息级语义, 在过滤后的桶里选):
        //   timestamp = 最后一条匹配消息; provider/model = 最后一条非空的匹配消息
        let mut cand_ts = String::new();
        let mut cand_prov = String::new();
        let mut cand_prov_ts = String::new();
        let mut cand_mdl = String::new();
        let mut cand_mdl_ts = String::new();
        for (key, sub) in &fa.sub {
            // 筛选项收集 (全量, 不随过滤收缩)
            if !key.0.is_empty() {
                filter_providers.insert(key.0.clone());
            }
            if !key.1.is_empty() {
                filter_models.insert(key.1.clone());
            }
            if let Some(p) = prov {
                if !key.0.eq_ignore_ascii_case(p) {
                    continue;
                }
            }
            if let Some(m) = mdl {
                if !key.1.eq_ignore_ascii_case(m) {
                    continue;
                }
            }
            // 时间过滤 = 按天桶选取; 无过滤时直接用子聚合全量 (含无时间戳消息)
            let mut a: DayAgg = if tf.none() {
                (sub.input, sub.output, sub.cache_read, sub.cache_write, sub.total, sub.cost, sub.msg_count)
            } else {
                (0, 0, 0, 0, 0, 0.0, 0)
            };
            for (day, d) in &sub.by_day {
                if !tf.day_in(day) {
                    continue;
                }
                let agg = &d.agg;
                if !tf.none() {
                    a.0 += agg.0;
                    a.1 += agg.1;
                    a.2 += agg.2;
                    a.3 += agg.3;
                    a.4 += agg.4;
                    a.5 += agg.5;
                    a.6 += agg.6;
                }
                let e = by_day.entry(day.clone()).or_insert((0, 0, 0, 0, 0, 0.0, 0));
                e.0 += agg.0;
                e.1 += agg.1;
                e.2 += agg.2;
                e.3 += agg.3;
                e.4 += agg.4;
                e.5 += agg.5;
                e.6 += agg.6;
                // 展示候选: 桶内最后一条 (非空 provider/model 按各自最后时间)
                if d.last_ts > cand_ts {
                    cand_ts = d.last_ts.clone();
                }
                if !d.last_provider_ts.is_empty() && d.last_provider_ts > cand_prov_ts {
                    cand_prov_ts = d.last_provider_ts.clone();
                    cand_prov = d.last_provider.clone();
                }
                if !d.last_model_ts.is_empty() && d.last_model_ts > cand_mdl_ts {
                    cand_mdl_ts = d.last_model_ts.clone();
                    cand_mdl = d.last_model.clone();
                }
            }
            if a.6 == 0 {
                continue;
            }
            file_total.0 += a.0;
            file_total.1 += a.1;
            file_total.2 += a.2;
            file_total.3 += a.3;
            file_total.4 += a.4;
            file_total.5 += a.5;
            file_total.6 += a.6;
            // sub.last_* 字段 (组合级最后一条) 仅无过滤兜底; 过滤路径已由桶候选覆盖
        }
        if file_total.6 == 0 {
            continue;
        }
        total.0 += file_total.0;
        total.1 += file_total.1;
        total.2 += file_total.2;
        total.3 += file_total.3;
        total.4 += file_total.4;
        total.5 += file_total.5;
        total.6 += file_total.6;
        // 候选已在过滤桶循环收集; 无过滤时桶覆盖全部带时间戳消息, 无需兜底
        // (无时间戳消息的展示差异可忽略: 真实数据消息均带 timestamp)
        let ts = cand_ts;
        sessions.push(serde_json::json!({
            "sessionId": fa.session_id, "fileName": fa.file_name,
            "project": fa.cwd, "provider": cand_prov, "model": cand_mdl,
            "timestamp": ts, "messageCount": file_total.6,
            "input": file_total.0, "output": file_total.1,
            "cacheRead": file_total.2, "cacheWrite": file_total.3,
            "total": file_total.4, "cost": file_total.5,
        }));
    }
    // 明细按时间倒序 (最新会话在前)
    sessions.sort_by(|a, b| {
        b["timestamp"]
            .as_str()
            .unwrap_or("")
            .cmp(a["timestamp"].as_str().unwrap_or(""))
    });

    serde_json::json!({
        "summary": {
            "input": total.0, "output": total.1,
            "cacheRead": total.2, "cacheWrite": total.3,
            "total": total.4, "cost": total.5,
            "messageCount": total.6, "sessionCount": sessions.len(),
        },
        "byDay": by_day.into_iter().map(|(date, (i, o, cr, cw, t, c, mc))| {
            serde_json::json!({ "date": date, "input": i, "output": o,
                "cacheRead": cr, "cacheWrite": cw, "total": t, "cost": c, "messageCount": mc })
        }).collect::<Vec<_>>(),
        "sessions": sessions,
        "filters": {
            "projects": filter_projects.into_iter().collect::<Vec<_>>(),
            "providers": filter_providers.into_iter().collect::<Vec<_>>(),
            "models": filter_models.into_iter().collect::<Vec<_>>(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// oracle 用: 一条有效 assistant 消息的原始字段 (旧实现消息级语义的输入)
    struct TMsg {
        ts: &'static str,
        provider: &'static str,
        model: &'static str,
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
        total: u64,
        cost: f64,
    }

    /// 测试文件: jsonl 原始行 (喂 scan_file) + oracle 消息列表 (喂 oracle 聚合)
    struct TFile {
        name: &'static str,
        cwd: &'static str,
        file_name: String, // 磁盘真实文件名 (oracle 对齐用)
        lines: Vec<String>,
        msgs: Vec<TMsg>,
    }

    /// 构造测试目录: 文件 A = 跨天会话 + 双 provider + 空 provider 消息 + total=0 跳过行;
    /// 文件 B = 单 provider + 原生 cost/cache
    /// name 区分用例, 避免并行测试共用临时目录互相污染
    fn setup(name: &str) -> (std::path::PathBuf, Vec<TFile>) {
        let dir = std::env::temp_dir().join(format!("pi_token_stats_test_{}_{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mk = |name: &'static str, cwd: &'static str, lines: Vec<&str>, msgs: Vec<TMsg>| {
            let mut lines: Vec<String> = lines.into_iter().map(|s| s.to_string()).collect();
            // cwd 是真实路径 (单反斜杠); 写入 JSON 需转义 (与 pi 落盘格式一致)
            let cwd_json = cwd.replace('\\', "\\\\");
            lines.insert(0, format!("{{\"type\":\"session\",\"id\":\"{name}\",\"cwd\":\"{cwd_json}\"}}"));
            TFile { name, cwd, file_name: String::new(), lines, msgs }
        };

        let mut files = vec![
            mk("a", "C:\\workspace\\proj-a", vec![
                "{\"type\":\"message\",\"id\":\"a1\",\"timestamp\":\"2026-07-01T10:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}",
                "{\"type\":\"message\",\"id\":\"a2\",\"timestamp\":\"2026-07-01T10:01:00.000Z\",\"message\":{\"role\":\"assistant\",\"provider\":\"huoshan\",\"model\":\"glm-5.2\",\"usage\":{\"input\":100,\"output\":50,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":150,\"cost\":{\"total\":0.5}}}}",
                "{\"type\":\"message\",\"id\":\"a3\",\"timestamp\":\"2026-07-02T09:00:00.000Z\",\"message\":{\"role\":\"assistant\",\"provider\":\"openai\",\"model\":\"gpt-5.2\",\"usage\":{\"prompt_tokens\":200,\"completion_tokens\":80,\"total_tokens\":280}}}",
                "{\"type\":\"message\",\"id\":\"a4\",\"timestamp\":\"2026-07-02T09:01:00.000Z\",\"message\":{\"role\":\"assistant\",\"provider\":\"openai\",\"model\":\"gpt-5.2\",\"usage\":{\"input\":0,\"output\":0,\"totalTokens\":0}}}",
                "{\"type\":\"message\",\"id\":\"a5\",\"timestamp\":\"2026-07-02T09:02:00.000Z\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input\":10,\"output\":5,\"totalTokens\":15}}}",
            ], vec![
                TMsg { ts: "2026-07-01T10:01:00.000Z", provider: "huoshan", model: "glm-5.2", input: 100, output: 50, cache_read: 0, cache_write: 0, total: 150, cost: 0.5 },
                TMsg { ts: "2026-07-02T09:00:00.000Z", provider: "openai", model: "gpt-5.2", input: 200, output: 80, cache_read: 0, cache_write: 0, total: 280, cost: 0.0 },
                TMsg { ts: "2026-07-02T09:02:00.000Z", provider: "", model: "", input: 10, output: 5, cache_read: 0, cache_write: 0, total: 15, cost: 0.0 },
            ]),
            mk("b", "C:\\workspace\\proj-b", vec![
                "{\"type\":\"message\",\"id\":\"b1\",\"timestamp\":\"2026-07-01T11:00:00.000Z\",\"message\":{\"role\":\"assistant\",\"provider\":\"anthropic\",\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input\":500,\"output\":100,\"cacheRead\":50,\"cacheWrite\":25,\"totalTokens\":675,\"cost\":{\"total\":1.25}}}}",
                "{\"type\":\"message\",\"id\":\"b2\",\"timestamp\":\"2026-07-03T08:00:00.000Z\",\"message\":{\"role\":\"assistant\",\"provider\":\"anthropic\",\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input\":300,\"output\":60,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":360,\"cost\":{\"total\":0.8}}}}",
            ], vec![
                TMsg { ts: "2026-07-01T11:00:00.000Z", provider: "anthropic", model: "claude-sonnet-4-5", input: 500, output: 100, cache_read: 50, cache_write: 25, total: 675, cost: 1.25 },
                TMsg { ts: "2026-07-03T08:00:00.000Z", provider: "anthropic", model: "claude-sonnet-4-5", input: 300, output: 60, cache_read: 0, cache_write: 0, total: 360, cost: 0.8 },
            ]),
        ];

        for (i, f) in files.iter_mut().enumerate() {
            let fname = format!("f{i}.jsonl");
            let path = dir.join(&fname);
            let mut file = std::fs::File::create(&path).unwrap();
            for l in &f.lines {
                writeln!(file, "{l}").unwrap();
            }
            f.file_name = fname;
        }
        (dir, files)
    }

    /// oracle: 旧实现消息级语义 (逐条过滤 + 聚合), 返回与 aggregate 同构的 JSON
    fn oracle(files: &[TFile], start: Option<&str>, end: Option<&str>, proj: Option<&str>, prov: Option<&str>, mdl: Option<&str>) -> Value {
        let mut total: DayAgg = (0, 0, 0, 0, 0, 0.0, 0);
        let mut by_day: BTreeMap<String, DayAgg> = BTreeMap::new();
        let mut sessions: Vec<Value> = Vec::new();
        let mut f_projects = BTreeSet::new();
        let mut f_providers = BTreeSet::new();
        let mut f_models = BTreeSet::new();

        for f in files {
            f_projects.insert(f.cwd.to_string());
            if let Some(p) = proj {
                if !f.cwd.eq_ignore_ascii_case(p) { continue; }
            }
            let mut file_total: DayAgg = (0, 0, 0, 0, 0, 0.0, 0);
            let mut last_ts = String::new();
            let mut last_prov = String::new();
            let mut last_mdl = String::new();
            for m in &f.msgs {
                if !m.provider.is_empty() { f_providers.insert(m.provider.to_string()); }
                if !m.model.is_empty() { f_models.insert(m.model.to_string()); }
                // 消息级过滤 (完整 ISO 字符串比较, 旧实现语义)
                if let Some(s) = start { if m.ts < s { continue; } }
                if let Some(e) = end { if m.ts > e { continue; } }
                if let Some(p) = prov { if !m.provider.eq_ignore_ascii_case(p) { continue; } }
                if let Some(mdl_) = mdl { if !m.model.eq_ignore_ascii_case(mdl_) { continue; } }
                file_total.0 += m.input; file_total.1 += m.output;
                file_total.2 += m.cache_read; file_total.3 += m.cache_write;
                file_total.4 += m.total; file_total.5 += m.cost; file_total.6 += 1;
                // 非空覆盖 (旧实现语义)
                if !m.provider.is_empty() { last_prov = m.provider.to_string(); }
                if !m.model.is_empty() { last_mdl = m.model.to_string(); }
                if !m.ts.is_empty() {
                    last_ts = m.ts.to_string();
                    let day = m.ts[..10].to_string();
                    let d = by_day.entry(day).or_insert((0, 0, 0, 0, 0, 0.0, 0));
                    d.0 += m.input; d.1 += m.output; d.2 += m.cache_read; d.3 += m.cache_write;
                    d.4 += m.total; d.5 += m.cost; d.6 += 1;
                }
            }
            if file_total.6 == 0 { continue; }
            total.0 += file_total.0; total.1 += file_total.1; total.2 += file_total.2;
            total.3 += file_total.3; total.4 += file_total.4; total.5 += file_total.5;
            total.6 += file_total.6;
            sessions.push(serde_json::json!({
                "fileName": f.file_name, "sessionId": f.name,
                "project": f.cwd, "provider": last_prov, "model": last_mdl,
                "timestamp": last_ts, "messageCount": file_total.6,
                "input": file_total.0, "output": file_total.1,
                "cacheRead": file_total.2, "cacheWrite": file_total.3,
                "total": file_total.4, "cost": file_total.5,
            }));
        }
        sessions.sort_by(|a, b| {
            b["timestamp"].as_str().unwrap_or("").cmp(a["timestamp"].as_str().unwrap_or(""))
        });
        serde_json::json!({
            "summary": {
                "input": total.0, "output": total.1,
                "cacheRead": total.2, "cacheWrite": total.3,
                "total": total.4, "cost": total.5,
                "messageCount": total.6, "sessionCount": sessions.len(),
            },
            "byDay": by_day.into_iter().map(|(date, (i, o, cr, cw, t, c, mc))| {
                serde_json::json!({ "date": date, "input": i, "output": o,
                    "cacheRead": cr, "cacheWrite": cw, "total": t, "cost": c, "messageCount": mc })
            }).collect::<Vec<_>>(),
            "sessions": sessions,
            "filters": {
                "projects": f_projects.into_iter().collect::<Vec<_>>(),
                "providers": f_providers.into_iter().collect::<Vec<_>>(),
                "models": f_models.into_iter().collect::<Vec<_>>(),
            },
        })
    }

    /// 索引聚合 vs oracle 对比: 覆盖无过滤/时间/供应商/模型/项目/组合过滤
    #[test]
    fn index_aggregate_matches_oracle() {
        let (dir, files) = setup("oracle");
        let mut index = TokenIndex { files: BTreeMap::new() };
        for i in 0..files.len() {
            let path = dir.join(format!("f{i}.jsonl"));
            if let Some(fa) = scan_file(&path) {
                index.files.insert(path, fa);
            }
        }
        let cases: Vec<(Option<&str>, Option<&str>, Option<&str>, Option<&str>, Option<&str>)> = vec![
            (None, None, None, None, None),                                        // 无过滤
            (Some("2026-07-02T00:00:00Z"), None, None, None, None),                // start 过滤 (跨天会话)
            (Some("2026-07-01T00:00:00Z"), Some("2026-07-04T00:00:00Z"), None, None, None), // 全含
            (Some("2026-07-01T00:00:00Z"), Some("2026-07-03T00:00:00Z"), None, None, None), // end 排除 07-03
            (None, None, None, Some("huoshan"), None),                             // provider
            (None, None, None, Some("ANTHROPIC"), None),                           // 大小写不敏感
            (None, None, None, None, Some("claude-sonnet-4-5")),                   // model
            (None, None, Some("C:\\workspace\\proj-a"), None, None),               // project
            (Some("2026-07-02T00:00:00Z"), None, None, Some("openai"), None),      // 组合
            (None, None, None, Some("nonexistent"), None),                         // 空结果
        ];
        for (i, (s, e, pj, pv, m)) in cases.iter().enumerate() {
            let tf = TimeFilter {
                start_day: s.map(|x| x[..10].to_string()),
                end_day: e.map(|x| x[..10].to_string()),
            };
            let got = aggregate(&index, &tf, *pj, *pv, *m);
            let want = oracle(&files, *s, *e, *pj, *pv, *m);
            assert_eq!(got, want, "case {i} mismatch\n got: {got}\nwant: {want}");
        }
    }

    /// 增量语义: 文件追加后重扫 (模拟 pi append-only 写盘) 能看到新消息
    #[test]
    fn rescan_picks_up_appended_messages() {
        let (dir, _files) = setup("append");
        let path = dir.join("f0.jsonl");
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{{\"type\":\"message\",\"id\":\"a6\",\"timestamp\":\"2026-07-04T09:00:00.000Z\",\"message\":{{\"role\":\"assistant\",\"provider\":\"huoshan\",\"model\":\"glm-5.2\",\"usage\":{{\"input\":7,\"output\":3,\"totalTokens\":10}}}}}}").unwrap();
        drop(f);

        let fa = scan_file(&path).unwrap();
        let sub = fa.sub.get(&("huoshan".to_string(), "glm-5.2".to_string())).unwrap();
        assert_eq!(sub.msg_count, 2);
        assert_eq!(sub.input, 107);
        assert_eq!(sub.total, 160);
    }
}

