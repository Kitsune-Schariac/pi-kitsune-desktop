// 对话行为统计: 轮数 / 工具分布 / thinking 占比 / 重试与压缩次数 / 轮耗时
//
// 与 token_stats.rs 共用同一增量索引与同一遍 scan_file 行循环 (设计 D1/D2):
// 行为扫描做成状态机 BehaviorScanner, 由 scan_file 的行循环逐行 feed,
// 不二次读盘、不二次 parse。历史与活动会话走同一解析器同一份文件,
// 口径一致性结构上保证 (无第二套事件流链路)。
//
// 关键口径 (2026-08-26 真实数据 + pi 包源码实测, 详见任务 design.md):
// - 落盘条目无 turn_start/turn_end, 轮 = user 消息切分;
//   streaming 中 steer 插队消息也落盘为 user, 会多切轮 —— 认领此偏移,
//   数字以文件自洽为准, 不对齐 pi 内存态 turnIndex
// - 重试推断: 同轮内 stopReason=error 的 assistant 之后无 user 介入直接续
//   assistant → 计 1 次自动重试 (pi _prepareRetry 只从内存 state 移除失败
//   消息, jsonl 行保留; 实测 error 后续分布: assistant 450 / user 125 /
//   compaction 8 / 文件尾 32)
// - thinking 占比是字符口径 (usage 不拆 reasoning token);
//   会话无任何 thinking block → thinkingChars=0 → 输出 null, 前端显示「无数据」
// - 轮归天 = 轮 start_ts 的 UTC 日, 轮内全部数据整归该天

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::session_fs;
use crate::token_stats;

/// 慢轮记录: 轮号 + 耗时 + 轮起始时间 (top 榜跨桶合并用)
#[derive(Clone, Default)]
pub(crate) struct SlowTurn {
    pub turn_idx: u32,
    pub duration_ms: u64,
    pub ts: String,
}

/// 可加行为聚合桶: 全量桶 (FileBehavior.all) 与按天桶 (by_day) 共用同一结构,
/// 查询期无时间过滤用全量桶、有过滤合并命中天桶, 两条路径同一套合并逻辑
#[derive(Default)]
pub(crate) struct DayBehavior {
    pub turns: u32,
    pub tool_calls: u32,
    pub tool_errors: u32,
    pub retries: u32,
    pub errors: u32,
    pub compactions: u32,
    pub thinking_chars: u64,
    pub text_chars: u64,
    pub duration_ms: u64,
    pub max_turn_ms: u64,
    /// 桶内最后轮的起始 ts (会话明细行「最后活跃时间」展示 + 倒序排序)
    pub last_ts: String,
    /// 桶内 top3 慢轮 (压索引体积; 查询期跨桶合并取 top10)
    pub slow_top: Vec<SlowTurn>,
    pub tool_dist: BTreeMap<String, u32>,
}

impl DayBehavior {
    /// 吸入一条闭合轮的全部标量
    fn absorb_turn(&mut self, idx: u32, t: &TurnRec) {
        self.turns += 1;
        self.tool_calls += t.tool_calls;
        self.tool_errors += t.tool_errors;
        self.retries += t.retries;
        self.errors += t.errors;
        self.thinking_chars += t.thinking_chars;
        self.text_chars += t.text_chars;
        self.duration_ms += t.duration_ms;
        if t.duration_ms > self.max_turn_ms {
            self.max_turn_ms = t.duration_ms;
        }
        if t.start_ts > self.last_ts {
            self.last_ts = t.start_ts.clone();
        }
        for (name, n) in &t.tools {
            *self.tool_dist.entry(name.clone()).or_insert(0) += n;
        }
        // 桶内慢轮 top3: 插入后按耗时降序截断
        self.slow_top.push(SlowTurn {
            turn_idx: idx,
            duration_ms: t.duration_ms,
            ts: t.start_ts.clone(),
        });
        self.slow_top.sort_by(|a, b| b.duration_ms.cmp(&a.duration_ms));
        self.slow_top.truncate(3);
    }

    /// 合并另一个桶 (查询期聚合用)
    fn absorb_bucket(&mut self, o: &DayBehavior) {
        self.turns += o.turns;
        self.tool_calls += o.tool_calls;
        self.tool_errors += o.tool_errors;
        self.retries += o.retries;
        self.errors += o.errors;
        self.compactions += o.compactions;
        self.thinking_chars += o.thinking_chars;
        self.text_chars += o.text_chars;
        self.duration_ms += o.duration_ms;
        if o.max_turn_ms > self.max_turn_ms {
            self.max_turn_ms = o.max_turn_ms;
        }
        if o.last_ts > self.last_ts {
            self.last_ts = o.last_ts.clone();
        }
        for (name, n) in &o.tool_dist {
            *self.tool_dist.entry(name.clone()).or_insert(0) += n;
        }
        self.slow_top.extend(o.slow_top.iter().cloned());
        self.slow_top.sort_by(|a, b| b.duration_ms.cmp(&a.duration_ms));
        self.slow_top.truncate(3);
    }
}

/// 单轮记录 (会话钻取视图逐轮展示)
#[derive(Clone, Default)]
pub(crate) struct TurnRec {
    pub start_ts: String,
    pub duration_ms: u64,
    pub tool_calls: u32,
    pub tool_errors: u32,
    /// 重试: 轮内 error assistant 后无 user 介入直接续 assistant 的次数
    pub retries: u32,
    /// stopReason=error 的 assistant 消息总数 (含被重试挽救的与被放弃的)
    pub errors: u32,
    pub thinking_chars: u64,
    pub text_chars: u64,
    /// 轮内工具分布 (钻取视图「这轮干了什么」用)
    pub tools: Vec<(String, u32)>,
}

/// 单文件行为聚合 (一个 jsonl = 一个会话)
#[derive(Default)]
pub(crate) struct FileBehavior {
    /// 全量桶 (含无时间戳数据); 无时间过滤时查询直接用它
    pub all: DayBehavior,
    /// 按 UTC 天桶; 轮内数据整归轮 start_ts 所在天
    pub by_day: BTreeMap<String, DayBehavior>,
    pub turns: Vec<TurnRec>,
}

/// ISO8601 毫秒解析: pi 落盘统一 `YYYY-MM-DDTHH:MM:SS[.fff]Z` (UTC)。
/// 为「字符串相减得耗时」引入 chrono 不值, 这里按固定格式解析;
/// 任何一位不符返回 None (数据路径不 panic), 该轮耗时记 0。
fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 {
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
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    // 毫秒部分可选; 时区只接受 Z (实测 pi 统一 UTC)
    let mut ms: i64 = 0;
    let mut i = 19;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let frac = &s[start..i];
        // 归一到毫秒: 截断到 3 位 + 右补零 ("5" → "500", 毫秒语义才是 500ms)
        let frac3 = format!("{:0<3}", &frac[..frac.len().min(3)]);
        ms = frac3.parse::<i64>().ok()?;
    }
    if i >= b.len() || b[i] != b'Z' {
        return None;
    }
    // days_from_civil (Howard Hinnant): 公历日期 → 距 1970-01-01 天数
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms)
}

/// 行为扫描状态机: scan_file 行循环逐行 feed, finish 产出 FileBehavior。
/// 轮内消息顺序即文件序 (append-only), 重试推断因此只需一轮遍历。
pub(crate) struct BehaviorScanner {
    behavior: FileBehavior,
    /// 当前轮的累计状态 (None = 还未遇任何 user/assistant)
    cur: Option<TurnCur>,
}

/// 轮内累计状态: start_ts 在轮首确定, end 以最后一条消息 ts 持续刷新
struct TurnCur {
    rec: TurnRec,
    last_ms: Option<i64>,
    start_ms: Option<i64>,
    /// 上一条 assistant 是 error: 本消息若为 assistant 记一次重试后清除;
    /// 若先来 user (放弃重试) 随轮闭合丢弃
    pending_error: bool,
}

impl BehaviorScanner {
    pub(crate) fn new() -> Self {
        Self {
            behavior: FileBehavior::default(),
            cur: None,
        }
    }

    /// 喂入一行已解析的 JSON (scan_file 保证空行/坏行已过滤)
    pub(crate) fn feed(&mut self, v: &Value) {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("message") => self.feed_message(v),
            // 压缩: 成功发生的压缩才落盘 (appendCompaction), 直接计数;
            // 归条目自身 ts 当天 (压缩发生在轮外, 不属于任何轮)
            Some("compaction") => {
                self.behavior.all.compactions += 1;
                let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
                if ts.len() >= 10 {
                    self.behavior
                        .by_day
                        .entry(ts[..10].to_string())
                        .or_default()
                        .compactions += 1;
                }
            }
            // model_change / thinking_level_change / custom / session_info: 非行为指标
            _ => {}
        }
    }

    fn feed_message(&mut self, v: &Value) {
        let msg = match v.get("message") {
            Some(m) => m,
            None => return,
        };
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
        let ts_ms = parse_iso_ms(ts);
        match role {
            "user" => {
                // user 消息 = 新一轮起点 (steer 插队也计一轮, 见头部口径注释)
                self.close_turn();
                let mut cur = TurnCur {
                    rec: TurnRec { start_ts: ts.to_string(), ..Default::default() },
                    last_ms: ts_ms,
                    start_ms: ts_ms,
                    pending_error: false,
                };
                if let (Some(s), Some(e)) = (cur.start_ms, cur.last_ms) {
                    cur.rec.duration_ms = (e - s).max(0) as u64;
                }
                self.cur = Some(cur);
            }
            "assistant" => {
                // 无 user 先行 (会话恢复/fork 场景): 开隐式轮, 保证消息不丢归属
                if self.cur.is_none() {
                    self.cur = Some(TurnCur {
                        rec: TurnRec { start_ts: ts.to_string(), ..Default::default() },
                        last_ms: None,
                        start_ms: ts_ms,
                        pending_error: false,
                    });
                }
                let Some(cur) = self.cur.as_mut() else { return };
                // 重试结算必须在判定本条是否 error 之前:
                // error → assistant(error) 也算一次被尝试的重试
                if cur.pending_error {
                    cur.rec.retries += 1;
                    cur.pending_error = false;
                }
                if msg.get("stopReason").and_then(|s| s.as_str()) == Some("error") {
                    cur.rec.errors += 1;
                    cur.pending_error = true;
                }
                // content blocks: thinking/text 字符 + 工具调用
                if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
                    for b in blocks {
                        let bt = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        match bt {
                            // thinking 文本键实测为 "thinking", "text" 兜底
                            "thinking" => {
                                let s = b
                                    .get("thinking")
                                    .or_else(|| b.get("text"))
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("");
                                // 字符数口径 (chars().count()), 不是字节数 (len()):
                                // 中文 3 字节/字符, 字节口径会让中文为主的正文权重×3,
                                // 占比失真 (实测偏差 text 29009 字符 → 45698 字节)
                                cur.rec.thinking_chars += s.chars().count() as u64;
                            }
                            "text" => {
                                let s = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                                cur.rec.text_chars += s.chars().count() as u64;
                            }
                            "toolCall" => {
                                let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
                                if !name.is_empty() {
                                    cur.rec.tool_calls += 1;
                                    match cur.rec.tools.iter_mut().find(|(n, _)| n == name) {
                                        Some((_, c)) => *c += 1,
                                        None => cur.rec.tools.push((name.to_string(), 1)),
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if let Some(e) = ts_ms {
                    cur.last_ms = Some(e);
                    if let Some(s) = cur.start_ms {
                        cur.rec.duration_ms = (e - s).max(0) as u64;
                    }
                }
            }
            "toolResult" => {
                // 工具失败: toolResult.isError 实测全带 (213/213);
                // 调用数以 assistant 的 toolCall 为准, 这里不重复计数
                if let Some(cur) = self.cur.as_mut() {
                    if msg.get("isError").and_then(|e| e.as_bool()) == Some(true) {
                        cur.rec.tool_errors += 1;
                    }
                    if let Some(e) = ts_ms {
                        cur.last_ms = Some(e);
                        if let Some(s) = cur.start_ms {
                            cur.rec.duration_ms = (e - s).max(0) as u64;
                        }
                    }
                }
            }
            // custom 角色 (插件消息): 非行为指标
            _ => {}
        }
    }

    /// 闭合当前轮并吸入聚合桶 (全量桶 + 按天桶)
    fn close_turn(&mut self) {
        let Some(cur) = self.cur.take() else { return };
        let idx = self.behavior.turns.len() as u32;
        let day = if cur.rec.start_ts.len() >= 10 {
            Some(cur.rec.start_ts[..10].to_string())
        } else {
            None
        };
        self.behavior.all.absorb_turn(idx, &cur.rec);
        // 无时间戳轮只进全量桶, 不进任何天桶 (按天过滤时自然不含, 对齐 token 口径)
        if let Some(day) = day {
            self.behavior.by_day.entry(day).or_default().absorb_turn(idx, &cur.rec);
        }
        self.behavior.turns.push(cur.rec);
    }

    /// 文件扫描收尾: 闭合末轮, 产出聚合
    pub(crate) fn finish(mut self) -> FileBehavior {
        self.close_turn();
        self.behavior
    }
}

/// thinking 占比: 无任何 thinking block → null (前端「无数据」, 不得显示 0%)
fn thinking_ratio(thinking: u64, text: u64) -> Option<f64> {
    if thinking == 0 {
        None
    } else {
        Some(thinking as f64 / (thinking + text) as f64)
    }
}

/// subagent 判定: 相对 sessions 根深度 > 2 (顶层会话 = <项目目录>/<文件>,
/// subagent 会话嵌套在 <项目目录>/<会话目录>/<hash>/run-N/session.jsonl)
fn is_subagent_path(sessions_root: &Path, path: &Path) -> bool {
    path.strip_prefix(sessions_root)
        .map(|rel| rel.components().count() > 2)
        .unwrap_or(false)
}

/// 时间过滤 (与 token_stats::TimeFilter 同语义: start 含当天, end 取次日 → 左闭右开)
struct DayRange {
    start_day: Option<String>,
    end_day: Option<String>,
}

impl DayRange {
    fn none(&self) -> bool {
        self.start_day.is_none() && self.end_day.is_none()
    }
    fn contains(&self, day: &str) -> bool {
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

/// 会话级聚合行: 按过滤条件从 FileBehavior 合成
/// (无过滤用全量桶; 有过滤合并命中天桶; 会话行时间用桶内 last_ts)
fn session_view(fb: &FileBehavior, range: &DayRange) -> DayBehavior {
    if range.none() {
        // 全量桶克隆 (会话行也要按过滤口径, 这里无过滤即全量)
        let mut b = DayBehavior::default();
        b.absorb_bucket(&fb.all);
        return b;
    }
    let mut b = DayBehavior::default();
    for (day, db) in &fb.by_day {
        if range.contains(day) {
            b.absorb_bucket(db);
        }
    }
    b
}

/// get_behavior_stats 聚合 (内存索引 fold, 毫秒级)
fn aggregate(index: &token_stats::TokenIndex, range: &DayRange, project: Option<&str>) -> Value {
    let Ok(sessions_root) = session_fs::agent_dir().map(|d| d.join("sessions")) else {
        return serde_json::json!({"error": "无法确定用户主目录"});
    };
    let mut total = DayBehavior::default();
    let mut by_day: BTreeMap<String, DayBehavior> = BTreeMap::new();
    let mut sessions: Vec<Value> = Vec::new();
    let mut filter_projects = BTreeSet::new();
    let mut slow_all: Vec<Value> = Vec::new();

    for (path, fa) in &index.files {
        // 项目归属与过滤口径必须与 token_stats::aggregate 完全一致 —— 两个面板共享同一个
        // 项目下拉 (StatsFilterBar), 只改一边会让同一筛选条件在两处覆盖不同的会话集合。
        // 子会话跟父会话走: 子代理 cwd 可能是项目子目录, 按自身 cwd 归类会掉出筛选
        let owner_cwd = fa
            .parent_path
            .as_ref()
            .and_then(|pp| index.files.get(pp))
            .map_or(fa.cwd.as_str(), |parent| parent.cwd.as_str());
        filter_projects.insert(owner_cwd.to_string());
        if let Some(p) = project {
            if !token_stats::project_matches(owner_cwd, p) {
                continue;
            }
        }
        let fb = &fa.behavior;
        let view = session_view(fb, range);
        if view.turns == 0 && view.compactions == 0 {
            continue;
        }
        // 慢轮 top 榜: 合并该会话过滤后桶的 slow_top, 带会话身份信息
        for st in &view.slow_top {
            slow_all.push(serde_json::json!({
                "sessionId": fa.session_id, "fileName": fa.file_name,
                "path": path.to_string_lossy(), "project": fa.cwd,
                "turnIdx": st.turn_idx, "durationMs": st.duration_ms, "ts": st.ts,
            }));
        }
        // 按天输出桶: 逐天跨文件合并
        for (day, db) in &fb.by_day {
            if !range.contains(day) {
                continue;
            }
            by_day.entry(day.clone()).or_default().absorb_bucket(db);
        }
        total.absorb_bucket(&view);
        sessions.push(serde_json::json!({
            "sessionId": fa.session_id, "fileName": fa.file_name,
            "path": path.to_string_lossy(),
            "project": fa.cwd,
            "isSubagent": is_subagent_path(&sessions_root, path),
            "timestamp": view.last_ts,
            "turns": view.turns, "toolCalls": view.tool_calls,
            "toolErrors": view.tool_errors, "retries": view.retries,
            "errors": view.errors, "compactions": view.compactions,
            "durationMs": view.duration_ms, "maxTurnMs": view.max_turn_ms,
            "thinkingRatio": thinking_ratio(view.thinking_chars, view.text_chars),
        }));
    }
    sessions.sort_by(|a, b| {
        b["timestamp"]
            .as_str()
            .unwrap_or("")
            .cmp(a["timestamp"].as_str().unwrap_or(""))
    });
    slow_all.sort_by(|a, b| {
        b["durationMs"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&a["durationMs"].as_u64().unwrap_or(0))
    });
    slow_all.truncate(10);

    let tool_dist: Vec<Value> = {
        let mut v: Vec<_> = total.tool_dist.iter().collect();
        v.sort_by(|a, b| b.1.cmp(a.1));
        v.into_iter()
            .map(|(name, count)| serde_json::json!({ "name": name, "count": count }))
            .collect()
    };
    let avg_turn_ms = if total.turns > 0 {
        total.duration_ms / total.turns as u64
    } else {
        0
    };
    serde_json::json!({
        "summary": {
            "turns": total.turns, "sessions": sessions.len(),
            "toolCalls": total.tool_calls, "toolErrors": total.tool_errors,
            "retries": total.retries, "errors": total.errors,
            "compactions": total.compactions,
            "thinkingChars": total.thinking_chars, "textChars": total.text_chars,
            "thinkingRatio": thinking_ratio(total.thinking_chars, total.text_chars),
            "durationMs": total.duration_ms, "avgTurnMs": avg_turn_ms,
            "maxTurnMs": total.max_turn_ms,
        },
        "byDay": by_day.into_iter().map(|(date, b)| {
            serde_json::json!({
                "date": date, "turns": b.turns, "toolCalls": b.tool_calls,
                "retries": b.retries, "compactions": b.compactions,
                "thinkingChars": b.thinking_chars, "textChars": b.text_chars,
                "durationMs": b.duration_ms,
            })
        }).collect::<Vec<_>>(),
        "toolDist": tool_dist,
        "slowTurns": slow_all,
        "sessions": sessions,
        "filters": { "projects": filter_projects.into_iter().collect::<Vec<_>>() },
    })
}

#[tauri::command]
pub fn get_behavior_stats(
    start_time: Option<String>,
    end_time: Option<String>,
    project: Option<String>,
) -> Result<Value, String> {
    let range = DayRange {
        start_day: start_time.as_deref().map(|s| s[..s.len().min(10)].to_string()),
        end_day: end_time.as_deref().map(|e| e[..e.len().min(10)].to_string()),
    };
    let proj = project.as_deref();
    Ok(token_stats::with_index(|index| {
        aggregate(index, &range, proj)
    }))
}

#[tauri::command]
pub fn get_session_behavior(path: String) -> Result<Value, String> {
    // 越界校验: 只允许 sessions 根内路径 (复用 session_fs 的 canonicalize 校验)
    let abs = session_fs::ensure_within_sessions(Path::new(&path))?;
    // canonicalize 返回的是 \\?\ 前缀的 verbatim 路径, 而索引 key 来自 read_dir 的普通
    // 路径形式——两者不相等, 直接查会 miss。剥掉前缀对齐索引 key。
    // (sessions 一定在本机用户目录, 不会命中 \\?\UNC\ 网络盘形式)
    let abs_key = abs
        .to_str()
        .and_then(|s| s.strip_prefix(r"\\?\"))
        .map(Path::new)
        .unwrap_or(abs.as_path())
        .to_path_buf();
    let Ok(sessions_root) = session_fs::agent_dir().map(|d| d.join("sessions")) else {
        return Err("无法确定用户主目录".to_string());
    };
    token_stats::with_index(|index| match index.files.get(&abs_key) {
        Some(fa) => {
            let fb = &fa.behavior;
            let all = &fb.all;
            let tool_dist: Vec<Value> = {
                let mut v: Vec<_> = all.tool_dist.iter().collect();
                v.sort_by(|a, b| b.1.cmp(a.1));
                v.into_iter()
                    .map(|(name, count)| serde_json::json!({ "name": name, "count": count }))
                    .collect()
            };
            Ok(serde_json::json!({
                "sessionId": fa.session_id, "fileName": fa.file_name,
                "project": fa.cwd,
                "isSubagent": is_subagent_path(&sessions_root, &abs_key),
                "summary": {
                    "turns": all.turns, "toolCalls": all.tool_calls,
                    "toolErrors": all.tool_errors, "retries": all.retries,
                    "errors": all.errors, "compactions": all.compactions,
                    "thinkingChars": all.thinking_chars, "textChars": all.text_chars,
                    "thinkingRatio": thinking_ratio(all.thinking_chars, all.text_chars),
                    "durationMs": all.duration_ms, "maxTurnMs": all.max_turn_ms,
                },
                "toolDist": tool_dist,
                "turns": fb.turns.iter().enumerate().map(|(i, t)| {
                    serde_json::json!({
                        "idx": i, "startTs": t.start_ts,
                        "durationMs": t.duration_ms,
                        "toolCalls": t.tool_calls, "toolErrors": t.tool_errors,
                        "retries": t.retries, "errors": t.errors,
                        "thinkingChars": t.thinking_chars, "textChars": t.text_chars,
                        "tools": t.tools,
                    })
                }).collect::<Vec<_>>(),
            }))
        }
        // 索引未收录: 文件刚被删除 (索引联动移除) 或无 session 头被跳过
        None => Err("会话文件未被索引 (可能已删除或不是有效会话)".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    /// 状态机核心口径: 轮的切分 / 耗时 / 工具 / thinking 字符
    #[test]
    fn scanner_basic_turn_split() {
        let mut sc = BehaviorScanner::new();
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:00:05.000Z","message":{"role":"assistant","stopReason":"toolUse","content":[{"type":"thinking","thinking":"想一想"},{"type":"text","text":"你好"},{"type":"toolCall","name":"bash","arguments":"{}"}]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:00:07.000Z","message":{"role":"toolResult","isError":true,"content":[]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:00:09.000Z","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"完成"}]}}"#));
        // 第二轮 (steer 插队同样切轮)
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:05:00.000Z","message":{"role":"user","content":[{"type":"text","text":"再来"}]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:05:03.000Z","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"好"}]}}"#));
        let fb = sc.finish();
        assert_eq!(fb.turns.len(), 2);
        assert_eq!(fb.turns[0].duration_ms, 9000); // 09.000 - 00.000
        assert_eq!(fb.turns[0].tool_calls, 1);
        assert_eq!(fb.turns[0].tool_errors, 1);
        assert_eq!(fb.turns[0].thinking_chars, 3); // "想一想" = 3 字符 (字符口径, 非字节)
        assert_eq!(fb.turns[0].text_chars, 4);     // "你好"(2) + "完成"(2), 两条 assistant 都归本轮
        assert_eq!(fb.turns[0].tools, vec![("bash".to_string(), 1)]);
        assert_eq!(fb.turns[1].duration_ms, 3000);
        assert_eq!(fb.all.turns, 2);
        // 按天桶: 两轮同天
        let d = fb.by_day.get("2026-07-01").unwrap();
        assert_eq!(d.turns, 2);
        assert_eq!(d.tool_calls, 1);
        assert_eq!(*d.tool_dist.get("bash").unwrap(), 1);
    }

    /// 重试推断矩阵: error→assistant 计重试; error→user 不计; 连续 error 逐次计
    #[test]
    fn scanner_retry_inference() {
        let mut sc = BehaviorScanner::new();
        // 轮1: error 后续 assistant (重试成功): retries=1, errors=1
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:00:00.000Z","message":{"role":"user","content":[]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"assistant","stopReason":"error","errorMessage":"boom","content":[]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:00:03.000Z","message":{"role":"assistant","stopReason":"stop","content":[]}}"#));
        // 轮2: error 后直接 user (放弃): retries=0, errors=1
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:01:00.000Z","message":{"role":"user","content":[]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:01:01.000Z","message":{"role":"assistant","stopReason":"error","errorMessage":"boom","content":[]}}"#));
        // 轮3: error→error→stop (两次重试): retries=2, errors=2
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:02:00.000Z","message":{"role":"user","content":[]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:02:01.000Z","message":{"role":"assistant","stopReason":"error","errorMessage":"e1","content":[]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:02:02.000Z","message":{"role":"assistant","stopReason":"error","errorMessage":"e2","content":[]}}"#));
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:02:03.000Z","message":{"role":"assistant","stopReason":"stop","content":[]}}"#));
        let fb = sc.finish();
        assert_eq!(fb.turns[0].retries, 1);
        assert_eq!(fb.turns[0].errors, 1);
        assert_eq!(fb.turns[1].retries, 0);
        assert_eq!(fb.turns[1].errors, 1);
        assert_eq!(fb.turns[2].retries, 2);
        assert_eq!(fb.turns[2].errors, 2);
        assert_eq!(fb.all.retries, 3);
        assert_eq!(fb.all.errors, 4);
    }

    /// compaction 计数 + 隐式轮 (assistant 无 user 先行) + thinking_ratio 空值
    #[test]
    fn scanner_compaction_and_implicit_turn() {
        let mut sc = BehaviorScanner::new();
        sc.feed(&line(r#"{"type":"message","timestamp":"2026-07-01T10:00:01.000Z","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"恢复"}]}}"#));
        sc.feed(&line(r#"{"type":"compaction","timestamp":"2026-07-01T10:00:02.000Z","summary":"..."}"#));
        let fb = sc.finish();
        assert_eq!(fb.turns.len(), 1); // 隐式轮
        assert_eq!(fb.all.compactions, 1);
        assert_eq!(fb.by_day.get("2026-07-01").unwrap().compactions, 1);
        // 无 thinking → None (前端「无数据」)
        assert_eq!(thinking_ratio(fb.all.thinking_chars, fb.all.text_chars), None);
    }

    /// parse_iso_ms: 带毫秒/不带毫秒/非法输入
    #[test]
    fn iso_ms_parse() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(
            parse_iso_ms("2026-07-01T10:00:00.500Z"),
            // 手算: 2026-07-01 距 epoch 天数由公式保证, 这里用差值验证相对正确性
            parse_iso_ms("2026-07-01T09:59:59.500Z").map(|v| v + 1000)
        );
        // 毫秒归一: .5 → 500ms (右补零, 不是 5ms)
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.5Z"), Some(500));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.12345Z"), Some(123)); // 截断
        assert_eq!(parse_iso_ms("not-a-date"), None);
        assert_eq!(parse_iso_ms("2026-07-01 10:00:00"), None); // 缺 T
        assert_eq!(parse_iso_ms("2026-07-01T10:00:00.000+08:00"), None); // 非 Z 拒收
        // 闰日: 2024-02-29 有效且 2024-03-01 差一天
        assert_eq!(
            parse_iso_ms("2024-03-01T00:00:00Z").unwrap() - parse_iso_ms("2024-02-29T00:00:00Z").unwrap(),
            86_400_000
        );
    }
}

