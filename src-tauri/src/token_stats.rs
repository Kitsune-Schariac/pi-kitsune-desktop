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
/// behavior: 行为统计聚合 (轮/工具/thinking/重试)——与 token 同一遍行扫描产出,
/// 见 behavior_stats.rs 头部口径注释
pub(crate) struct FileAgg {
    /// 增量守卫: 两者任一不匹配即触发该文件重扫 (append-only 场景 mtime 必变,
    /// size 兜底防 mtime 粒度/时钟异常)
    mtime_nanos: i128,
    size_bytes: u64,
    /// 文件级信息 (session 头权威来源)
    pub(crate) cwd: String,
    pub(crate) file_name: String,
    pub(crate) session_id: String,
    /// 子代理归属: session_info.name 归一化后的 agent 名 (见 normalize_agent); 主会话为空
    pub(crate) agent: String,
    /// 父会话文件绝对路径; 顶层主会话为 None。由 ensure_index 填 —— scan_file 只拿到单文件
    /// path, 算不出相对 sessions 根的深度。is_subagent 不另存字段, parent_path.is_some() 即是
    pub(crate) parent_path: Option<PathBuf>,
    /// R7 不可见量: 未落盘的前台同步 subagent dispatch 次数, 按天 (键 = toolResult 行的
    /// timestamp 前 10 字符)。这类子代理不写独立会话, token 在磁盘上不存在, 只能数次数
    pub(crate) opaque_by_day: BTreeMap<String, u64>,
    pub(crate) behavior: crate::behavior_stats::FileBehavior,
    sub: BTreeMap<(String, String), SubAgg>,
}

/// 全局索引: 只增改删, 查询时全量 fold (几百条记录, 微秒级)
pub(crate) struct TokenIndex {
    pub(crate) files: BTreeMap<PathBuf, FileAgg>,
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

/// session_info.name → agent 名。实测两种形态 (agent 名自身含 `-`, 只能从尾部剥):
///   subagent-scout-0c30aeec-1                                      短 hex8 + 序号
///   subagent-trellis-check-844e413c-bff6-407b-856b-b3a6216b8f59-1  完整 uuid + 序号
///
/// id 只认这两种精确形态: 宁可漏剥 (显示带 id 的长名字, 难看但无害) 也不误剥 ——
/// agent 名末段恰好是 8 位 hex 时被吃掉, 是静默的错误归属
fn normalize_agent(raw: &str) -> String {
    let Some(body) = raw.strip_prefix("subagent-") else {
        return raw.to_string(); // 未知形态不猜
    };
    // 尾部纯十进制序号
    let body = match body.rsplit_once('-') {
        Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => head,
        _ => body,
    };
    let is_hex = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_hexdigit());
    let segs: Vec<&str> = body.split('-').collect();
    let n = segs.len();
    let head = if n >= 6
        && is_hex(segs[n - 5], 8)
        && is_hex(segs[n - 4], 4)
        && is_hex(segs[n - 3], 4)
        && is_hex(segs[n - 2], 4)
        && is_hex(segs[n - 1], 12)
    {
        segs[..n - 5].join("-")
    } else if n >= 2 && is_hex(segs[n - 1], 8) {
        segs[..n - 1].join("-")
    } else {
        return body.to_string();
    };
    if head.is_empty() {
        body.to_string() // 剥空了 → 保留剥 id 前的内容
    } else {
        head
    }
}

/// 子会话 → 父会话文件路径。子会话落盘形态相对 sessions 根恒为 5 段:
/// `<项目目录>/<父会话stem>/<子ID>/run-N/session.jsonl` (实测 235/235)。
///
/// 只用前两段, 不校验后续段数 —— 对 run-N 层级变化保持宽松, 与
/// behavior_stats::is_subagent_path 的深度判据同源, 别引入第二套更严的规则。
/// 返回路径不保证存在 (父会话可能已被删), 这类子会话在聚合时按孤儿平铺
fn parent_session_path(sessions_root: &Path, path: &Path) -> Option<PathBuf> {
    let rel = path.strip_prefix(sessions_root).ok()?;
    let segs: Vec<_> = rel.components().collect();
    if segs.len() <= 2 {
        return None; // 顶层主会话
    }
    let stem = segs[1].as_os_str().to_string_lossy().to_string();
    Some(sessions_root.join(segs[0].as_os_str()).join(format!("{stem}.jsonl")))
}

/// 项目过滤: 全等, 或 filter 是 cwd 的祖先目录。
///
/// 必须按分隔符边界判定, 不能裸 starts_with —— 否则 `…\hanjiang\pi` 会误命中
/// `…\hanjiang\pi-kitsune-desktop`。cwd 来自 pi, 正反斜杠都可能出现, 两种都认。
/// pub(crate): behavior_stats 共用同一口径 (两面板共享项目下拉, 只改一处会范围打架)
pub(crate) fn project_matches(cwd: &str, filter: &str) -> bool {
    let filter = filter.trim_end_matches(['\\', '/']);
    if filter.is_empty() {
        return true; // 空筛选 = 不过滤
    }
    // 分隔符归一后比较: cwd 来自 pi 会话头, filter 来自前端下拉 (选项取自同一批 cwd),
    // 正常两者分隔符一致, 归一是防御性的 —— 几百次调用的分配开销可忽略
    let norm = |s: &str| s.replace('\\', "/").to_ascii_lowercase();
    let (c, f) = (norm(cwd), norm(filter));
    c == f || (c.len() > f.len() && c.starts_with(&f) && c.as_bytes()[f.len()] == b'/')
}

/// 扫描单个会话文件, 产出聚合快照; 无 session 头返回 None (该文件不入索引)
/// pub(crate): behavior_stats 测试与冒烟核对真实数据用
pub(crate) fn scan_file(path: &Path) -> Option<FileAgg> {
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
    let mut agent = String::new();
    let mut opaque_by_day: BTreeMap<String, u64> = BTreeMap::new();
    // R7 配对表: 已派发但尚未见到 toolResult 的 dispatch toolCallId。
    // 扫完仍留在表里的 = 会话中断, 无从判定落盘与否, 不计 (计入就是猜)
    let mut pending_dispatch: BTreeSet<String> = BTreeSet::new();
    let mut sub: BTreeMap<(String, String), SubAgg> = BTreeMap::new();
    let mut behavior_scanner = crate::behavior_stats::BehaviorScanner::new();
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // 行为扫描必须逐行无遗漏: token 分支内有多个 continue (无 usage/非 assistant),
        // 因此 feed 放在 match 之前——行为口径不依赖 usage 字段
        behavior_scanner.feed(&v);
        // R7: 前台同步 subagent dispatch 计数。这类子代理不落盘独立会话 (见 prd.md 事实 3),
        // token 无处可查, 只能数次数在界面上如实标注"这部分算不到"。
        //
        // 必须放在下面 match 之前: match 的 message 分支在无 usage 时 continue,
        // 而 toolResult 恰恰没有 usage, 放进去就永远数不到。
        //
        // 禁止用 details.totalChildUsage 往 token 里补数: 实测带该字段的 result 其
        // sessionFile 169/169 全部存在且已入索引, 补进来是纯双计 (prd.md 事实 4)
        if let Some(msg) = v.get("message") {
            match msg.get("role").and_then(|r| r.as_str()) {
                Some("assistant") => {
                    for c in msg.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
                        if c.get("type").and_then(|t| t.as_str()) != Some("toolCall") {
                            continue;
                        }
                        // 识别集合与前端 fleetStream.ts 的 SUBAGENT_STREAM_TOOLS 逐字一致
                        let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if !matches!(name, "subagent" | "subagent_wait" | "trellis_subagent") {
                            continue;
                        }
                        // 只带 action 的是管理操作 (list/status/children.list), 不是 dispatch
                        let args = c.get("arguments");
                        let is_dispatch = ["agent", "agent_name", "prompt", "task"]
                            .iter()
                            .any(|k| args.and_then(|a| a.get(k)).is_some());
                        if is_dispatch {
                            if let Some(id) = c.get("id").and_then(|i| i.as_str()) {
                                pending_dispatch.insert(id.to_string());
                            }
                        }
                    }
                }
                Some("toolResult") => {
                    let id = msg.get("toolCallId").and_then(|i| i.as_str()).unwrap_or("");
                    if pending_dispatch.remove(id) {
                        // 子会话已落盘 → token 已由那份独立会话文件统计, 不算不可见量。
                        // 判据用 sessionFile 字段存在性而非 is_file(): scan_file 是热路径,
                        // 不该为每次 dispatch 发一次 stat; 实测有该字段的 169 个全部存在
                        let landed = msg
                            .get("details")
                            .and_then(|d| d.get("results"))
                            .and_then(|r| r.as_array())
                            .map_or(false, |rs| {
                                rs.iter().any(|r| {
                                    r.get("sessionFile")
                                        .and_then(|s| s.as_str())
                                        .map_or(false, |s| !s.is_empty())
                                })
                            });
                        if !landed {
                            let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
                            let day = ts[..ts.len().min(10)].to_string();
                            *opaque_by_day.entry(day).or_insert(0) += 1;
                        }
                    }
                }
                _ => {}
            }
        }
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
            // 子代理会话的 agent 名 (实测恒在第 4 行, 每会话至多一条)。
            // 只取首条: 会话改名时末条覆盖首条会造成归属漂移
            Some("session_info") => {
                if agent.is_empty() {
                    agent = normalize_agent(v.get("name").and_then(|n| n.as_str()).unwrap_or(""));
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
        agent,
        parent_path: None, // ensure_index 填, 见字段注释
        opaque_by_day,
        behavior: behavior_scanner.finish(),
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
            Some(mut fa) => {
                fa.parent_path = parent_session_path(&sessions_root, path);
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

/// 索引只读访问入口: ensure_index (增量守卫) + 持锁 fold。
/// 行为统计等其它查询共用同一索引, 一律经此入口 (锁中毒对齐 into_inner 模式)
pub(crate) fn with_index<R>(f: impl FnOnce(&TokenIndex) -> R) -> R {
    ensure_index();
    let guard = match token_index().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    f(&guard)
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
    agent: Option<String>,
) -> Result<Value, String> {
    // ISO 前 10 字符 = UTC 日期 (start 取当天零点所在日, end 取次日零点所在日)
    let tf = TimeFilter {
        start_day: start_time.as_deref().map(|s| s[..s.len().min(10)].to_string()),
        end_day: end_time.as_deref().map(|e| e[..e.len().min(10)].to_string()),
    };
    let proj = project.as_deref();
    let prov = provider.as_deref();
    let mdl = model.as_deref();
    let agt = agent.as_deref().filter(|a| !a.is_empty());

    // 增量守卫: 只重扫变化的文件; 之后查询走内存索引 (毫秒级)
    ensure_index();
    let guard = match token_index().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    Ok(aggregate(&guard, &tf, proj, prov, mdl, agt))
}

/// 从内存索引按过滤条件聚合 (与旧实现消息级口径保持一致, 见 TimeFilter 注释)
fn aggregate(
    index: &TokenIndex,
    tf: &TimeFilter,
    proj: Option<&str>,
    prov: Option<&str>,
    mdl: Option<&str>,
    // 行级来源过滤: 哨兵 __main__ / __sub__, 或精确 agent 名
    agt: Option<&str>,
) -> Value {
    // 汇总 (DayAgg 复用): total + by_day + 明细行 + 全量筛选集合
    let mut total: DayAgg = (0, 0, 0, 0, 0, 0.0, 0);
    let mut by_day: BTreeMap<String, DayAgg> = BTreeMap::new();
    let mut sessions: Vec<Value> = Vec::new();
    let mut filter_projects = BTreeSet::new();
    let mut filter_providers = BTreeSet::new();
    let mut filter_models = BTreeSet::new();
    let mut filter_agents = BTreeSet::new();
    let mut opaque_total: u64 = 0;

    for (path, fa) in &index.files {
        // 项目归属: 子会话跟父会话走。子代理 cwd 可能是项目子目录 (如 …\proj\desktop),
        // 按自身 cwd 归类会让它变成独立的项目选项而掉出筛选 (见 prd.md 事实 9)
        let owner_cwd = fa
            .parent_path
            .as_ref()
            .and_then(|pp| index.files.get(pp))
            .map_or(fa.cwd.as_str(), |parent| parent.cwd.as_str());
        // 项目过滤: 文件级 (归属 cwd 不匹配则整个会话跳过)
        filter_projects.insert(owner_cwd.to_string());
        if !fa.agent.is_empty() {
            filter_agents.insert(fa.agent.clone()); // 全量收集, 不随过滤收缩
        }
        if let Some(p) = proj {
            if !project_matches(owner_cwd, p) {
                continue;
            }
        }
        // R7 不可见量: 只受时间 + 项目过滤影响。这些 dispatch 没有 usage 记录, 自然也没有
        // provider/model/agent 归属, 让它跟着那些筛选变化只会给出误导性数字 (design §6.2)。
        // 累加放在 agent 过滤之前, 也放在「该会话无 token 消息就 continue」之前 ——
        // 不可见量不该因为宿主会话本身没 token 而丢失
        let file_opaque: u64 = fa
            .opaque_by_day
            .iter()
            .filter(|(day, _)| tf.day_in(day))
            .map(|(_, n)| *n)
            .sum();
        opaque_total += file_opaque;
        // 来源过滤 (行级): 选中具体 agent 时父会话行会被滤掉而子行留下, 前端按「父不在
        // 结果集」平铺 —— 用户问的是「这个 agent 花了多少」, 不该被父会话行干扰
        if let Some(a) = agt {
            let is_sub = fa.parent_path.is_some();
            let hit = match a {
                "__main__" => !is_sub,
                "__sub__" => is_sub,
                name => fa.agent.eq_ignore_ascii_case(name),
            };
            if !hit {
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
            // path 是索引 key, 全局唯一 —— 前端拿它当行 key (子会话文件名恒为 session.jsonl,
            // 靠 fileName+timestamp 组 key 撞上就静默丢行)
            "path": path.to_string_lossy(),
            "project": owner_cwd, "cwd": fa.cwd,
            "agent": fa.agent,
            "parentPath": fa
                .parent_path
                .as_ref()
                .map(|pp| pp.to_string_lossy().to_string())
                .unwrap_or_default(),
            "opaqueDispatches": file_opaque,
            "provider": cand_prov, "model": cand_mdl,
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
            "opaqueDispatches": opaque_total,
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
            "agents": filter_agents.into_iter().collect::<Vec<_>>(),
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
    fn oracle(dir: &Path, files: &[TFile], start: Option<&str>, end: Option<&str>, proj: Option<&str>, prov: Option<&str>, mdl: Option<&str>) -> Value {
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
                // 测试样本全是顶层会话: 无父、无 agent 名、无未落盘 dispatch, 归属字段取平凡值
                "path": dir.join(&f.file_name).to_string_lossy(),
                "project": f.cwd, "cwd": f.cwd,
                "agent": "", "parentPath": "", "opaqueDispatches": 0,
                "provider": last_prov, "model": last_mdl,
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
                "opaqueDispatches": 0,
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
                "agents": Vec::<String>::new(),
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
            let got = aggregate(&index, &tf, *pj, *pv, *m, None);
            let want = oracle(&dir, &files, *s, *e, *pj, *pv, *m);
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

    /// agent 名归一化: 两种真实 id 形态 + agent 名自身含 `-` + 未知形态不猜
    #[test]
    fn normalize_agent_strips_ids() {
        let cases = [
            ("subagent-scout-0c30aeec-1", "scout"),
            (
                "subagent-trellis-check-844e413c-bff6-407b-856b-b3a6216b8f59-1",
                "trellis-check",
            ),
            ("subagent-deep-explorer-1e6b1920-1", "deep-explorer"),
            ("subagent-trellis-implement-6b3e547a-1", "trellis-implement"),
            // 无 subagent- 前缀: 未知形态原样返回, 不猜
            ("main-session", "main-session"),
            ("", ""),
            // 无 id 后缀: 剥不动就保留
            ("subagent-reviewer", "reviewer"),
        ];
        for (raw, want) in cases {
            assert_eq!(normalize_agent(raw), want, "raw={raw}");
        }
    }

    /// 父会话推导: 5 段子会话路径 → 父 jsonl; 2 段顶层会话 → None
    #[test]
    fn parent_path_from_nested_layout() {
        let root = Path::new("/s");
        let child = root.join("--C--proj--").join("2026-08-27T03-49-16-545Z_uuid").join("7195e563").join("run-0").join("session.jsonl");
        assert_eq!(
            parent_session_path(root, &child),
            Some(root.join("--C--proj--").join("2026-08-27T03-49-16-545Z_uuid.jsonl"))
        );
        let top = root.join("--C--proj--").join("2026-08-27T03-49-16-545Z_uuid.jsonl");
        assert_eq!(parent_session_path(root, &top), None);
        // 不在 sessions 根下 → None (strip_prefix 失败)
        assert_eq!(parent_session_path(root, Path::new("/other/x.jsonl")), None);
    }

    /// 项目过滤的边界匹配 —— R4 的核心防线是「真前缀但非目录边界不得命中」
    #[test]
    fn project_matches_respects_path_boundary() {
        let base = r"C:\workspace\hanjiang";
        assert!(project_matches(base, base), "全等应命中");
        assert!(project_matches(r"C:\workspace\hanjiang\pi-kitsune-desktop", base), "子目录应命中");
        assert!(
            !project_matches(r"C:\workspace\hanjiang\pi-kitsune-desktop", r"C:\workspace\hanjiang\pi"),
            "祖先目录 pi 不得误命中同级的 pi-kitsune-desktop (真前缀但非目录边界)"
        );
        assert!(project_matches(r"C:\workspace\hanjiang\x", r#"C:\workspace\hanjiang\"#), "filter 带尾分隔符");
        assert!(project_matches("C:/workspace/hanjiang/x", base), "正反斜杠混用");
        assert!(project_matches(r"c:\WORKSPACE\hanjiang\x", base), "大小写不敏感");
        assert!(!project_matches(r"C:\other\x", base), "不同项目不得命中");
        assert!(project_matches(r"C:\anything", ""), "空筛选 = 不过滤");
    }

    /// R6 防回归: subagent-artifacts 下的 *_transcript.jsonl 是同一份数据的第二份落盘
    /// (无 type 字段, 用 recordType; cwd 在每行上而非 session 头)。scan_file 必须跳过它。
    ///
    /// **跳过是刻意的**: 支持该格式会与 sessions 下的 run-N/session.jsonl 双重计数。
    /// 已用 runId f248d88f 交叉验证 —— transcript 与其 status.json 指向的 sessionFile
    /// token 合计完全相同 (2,918,131), 二者同源
    #[test]
    fn transcript_format_is_skipped_not_double_counted() {
        let dir = std::env::temp_dir().join("tok_transcript_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("run_trellis-implement_transcript.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"{{"version":1,"recordType":"message","source":"async","agent":"trellis-implement","cwd":"C:/proj","role":"user","message":{{"role":"user","content":[]}}}}"#).unwrap();
        writeln!(f, r#"{{"version":1,"recordType":"message","source":"async","agent":"trellis-implement","cwd":"C:/proj","role":"assistant","message":{{"role":"assistant","usage":{{"input":100,"output":10,"totalTokens":110}}}}}}"#).unwrap();
        drop(f);

        assert!(
            scan_file(&path).is_none(),
            "transcript 无 session 头, 必须不入索引 —— 否则与 run-N/session.jsonl 双计"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R7 计数的四条判据 (design §6.1): 落盘不计 / 未落盘计 / 管理操作不计 / 无 toolResult 不计
    #[test]
    fn opaque_dispatch_counting_rules() {
        let dir = std::env::temp_dir().join("tok_opaque_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        let call = |id: &str, name: &str, args: &str| {
            format!(
                r#"{{"type":"message","timestamp":"2026-08-30T01:00:00.000Z","message":{{"role":"assistant","content":[{{"type":"toolCall","id":"{id}","name":"{name}","arguments":{args}}}]}}}}"#
            )
        };
        let result = |id: &str, details: &str| {
            format!(
                r#"{{"type":"message","timestamp":"2026-08-30T02:00:00.000Z","message":{{"role":"toolResult","toolCallId":"{id}","toolName":"subagent","details":{details}}}}}"#
            )
        };
        writeln!(f, r#"{{"type":"session","id":"s1","cwd":"C:/proj"}}"#).unwrap();
        // d1: dispatch + 结果带 sessionFile → 子会话已落盘, 不计
        writeln!(f, "{}", call("d1", "subagent", r#"{"agent":"scout","prompt":"go"}"#)).unwrap();
        writeln!(f, "{}", result("d1", r#"{"results":[{"sessionFile":"C:/x/run-0/session.jsonl"}]}"#)).unwrap();
        // d2: dispatch + 结果无 sessionFile → 前台同步, 计 1
        writeln!(f, "{}", call("d2", "trellis_subagent", r#"{"agent":"trellis-implement","prompt":"go"}"#)).unwrap();
        writeln!(f, "{}", result("d2", r#"{"kind":"trellis-subagent-progress","runs":[{"status":"succeeded"}]}"#)).unwrap();
        // d3: 管理操作 (只有 action) → 不是 dispatch, 即便结果无 sessionFile 也不计
        writeln!(f, "{}", call("d3", "subagent", r#"{"action":"list"}"#)).unwrap();
        writeln!(f, "{}", result("d3", r#"{"mode":"management","results":[]}"#)).unwrap();
        // d4: dispatch 但无 toolResult (会话中断) → 无从判定, 不计
        writeln!(f, "{}", call("d4", "subagent", r#"{"agent":"reviewer","task":"go"}"#)).unwrap();
        drop(f);
        let fa = scan_file(&path).unwrap();
        let total: u64 = fa.opaque_by_day.values().sum();
        assert_eq!(total, 1, "只有 d2 该计入, 实得 {:?}", fa.opaque_by_day);
        assert_eq!(fa.opaque_by_day.get("2026-08-30"), Some(&1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真实数据冒烟 (照 subagent_fleet::scan_real_tmp_smoke 的既有模式)。
    /// 核对归属维度与 R7 计数是否与立项实测一致, 并对 PRD 验收 1/2/3/4/7 逐条对数。
    /// `cargo test --lib real_sessions_attribution_smoke -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_sessions_attribution_smoke() {
        let tf = TimeFilter { start_day: None, end_day: None };
        with_index(|index| {
            let mut children = 0usize;
            let mut named = 0usize;
            let mut agents: BTreeMap<String, u64> = BTreeMap::new();
            for fa in index.files.values() {
                if fa.parent_path.is_some() {
                    children += 1;
                    if !fa.agent.is_empty() {
                        named += 1;
                        *agents.entry(fa.agent.clone()).or_insert(0) += 1;
                    }
                }
            }
            eprintln!("[归属] 索引文件 {} / 子会话 {children} (其中有 agent 名 {named})", index.files.len());

            // --- 验收 1/2/7: 无筛选全量 ---
            let all = aggregate(index, &tf, None, None, None, None);
            let sm = &all["summary"];
            eprintln!(
                "[全量] 会话 {} / total {} / 不可见 dispatch {}",
                sm["sessionCount"], sm["total"], sm["opaqueDispatches"]
            );
            eprintln!("       (立项实测: 570 行 / 2,265,547,615 tokens / 114 次)");

            // --- 验收 3: 本项目 ---
            let proj = r"C:\workspace\hanjiang\pi-kitsune-desktop";
            let mine = aggregate(index, &tf, Some(proj), None, None, None);
            eprintln!(
                "[本项目] 会话 {} / total {}  (立项实测: 54 / 391,925,455)",
                mine["summary"]["sessionCount"], mine["summary"]["total"]
            );
            let subs: Vec<_> = mine["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| !r["parentPath"].as_str().unwrap_or("").is_empty())
                .collect();
            let sub_tok: u64 = subs.iter().map(|r| r["total"].as_u64().unwrap_or(0)).sum();
            eprintln!("         其中子代理 {} 个 / {sub_tok} tokens  (立项实测: 9 / 7,489,116)", subs.len());

            // --- 验收 4: 项目边界前缀匹配 ---
            let yra = r"C:\workspace\hanjiang\YukiRemoteAgent";
            let y = aggregate(index, &tf, Some(yra), None, None, None);
            let nested: Vec<_> = y["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| !r["cwd"].as_str().unwrap_or("").eq_ignore_ascii_case(yra))
                .collect();
            eprintln!(
                "[YukiRemoteAgent] 会话 {} / 其中 cwd 为子目录的 {} 个 (R4 修复前这些会掉出筛选)",
                y["summary"]["sessionCount"], nested.len()
            );
            assert!(!nested.is_empty(), "R4 未生效: cwd 为子目录的子代理会话没被包含进来");

            // 项目下拉不得再单独列出子目录 (归属已跟父会话走)
            let projects: Vec<&str> = all["filters"]["projects"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|p| p.as_str())
                .filter(|p| p.len() > yra.len() && p.to_ascii_lowercase().starts_with(&yra.to_ascii_lowercase()))
                .collect();
            eprintln!("[项目下拉] YukiRemoteAgent 的子目录选项: {projects:?} (应为空)");
            assert!(projects.is_empty(), "项目下拉仍单独列出子目录: {projects:?}");

            // --- 验收 7 口径: 不可见量不受 provider/model/agent 筛选影响 ---
            let any_provider = all["filters"]["providers"][0].as_str().unwrap_or("").to_string();
            let by_prov = aggregate(index, &tf, None, Some(&any_provider), None, None);
            assert_eq!(
                by_prov["summary"]["opaqueDispatches"], sm["opaqueDispatches"],
                "不可见量不该随 provider 筛选变化 (它没有 provider 归属)"
            );
            let only_sub = aggregate(index, &tf, None, None, None, Some("__sub__"));
            assert_eq!(
                only_sub["summary"]["opaqueDispatches"], sm["opaqueDispatches"],
                "不可见量不该随来源筛选变化"
            );

            // --- agent 行级筛选 ---
            let only_main = aggregate(index, &tf, None, None, None, Some("__main__"));
            eprintln!(
                "[来源筛选] 仅主会话 {} 行 / 仅子代理 {} 行 (合计应等于全量 {})",
                only_main["summary"]["sessionCount"], only_sub["summary"]["sessionCount"], sm["sessionCount"]
            );
            assert_eq!(
                only_main["summary"]["sessionCount"].as_u64().unwrap()
                    + only_sub["summary"]["sessionCount"].as_u64().unwrap(),
                sm["sessionCount"].as_u64().unwrap(),
                "主会话 + 子代理应无重不漏地覆盖全量"
            );
            assert_eq!(
                only_main["summary"]["total"].as_u64().unwrap()
                    + only_sub["summary"]["total"].as_u64().unwrap(),
                sm["total"].as_u64().unwrap(),
                "两者 token 相加应等于全量 (归并不改变总量)"
            );
            let ti = aggregate(index, &tf, None, None, None, Some("trellis-implement"));
            eprintln!(
                "[agent=trellis-implement] {} 行 / {} tokens",
                ti["summary"]["sessionCount"], ti["summary"]["total"]
            );
            assert!(
                ti["sessions"].as_array().unwrap().iter().all(|r| r["agent"] == "trellis-implement"),
                "按 agent 名筛选后不得混入其它来源的行"
            );

            // --- agent 维度 ---
            let mut v: Vec<_> = agents.into_iter().collect();
            v.sort_by(|a, b| b.1.cmp(&a.1));
            for (a, c) in v.iter().take(12) {
                eprintln!("    {c:>4}  {a}");
            }
        });
    }
}

