//! Subagent 舰队视图数据源: 扫描 pi-subagents 产物目录, 宽松解析 status.json + events.jsonl。
//!
//! 数据源: `$TMP/pi-subagents-*/async-subagent-runs/<runId>/status.json` (+ 同目录 events.jsonl)。
//! 不自行推算 scope 字符串 (本机两 scope `pi-subagents-user-nonascii-...` 与
//! `pi-subagents-user-unknown` 并存, GUI 进程环境与 pi 子进程可能不同, 重算会指向错误目录),
//! 多 scope glob 全扫; 权威精确定位留给前端从 subagent 工具结果 `details.asyncDir` 拿目录。
//!
//! 解析策略 (PRD R5 前向兼容): `serde_json::Value` 读入后手动取字段 (`as_str/as_u64.unwrap_or`
//! 风格), 任何字段缺失/类型不符都给默认值而非报错; **单 run 解析失败只跳过该 run**,
//! 绝不让整个列表失败。上游明确要求消费者忽略未知字段, 故不 derive 严格 struct。

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 单个 step 的精简摘要 (run 内的一个子 agent 步)。
/// 字段可缺 (workflow 模式 step 无 tokens/error/exitCode, single 模式齐全), 全部默认值兜底。
#[derive(Serialize, Clone, PartialEq)]
pub struct FleetStepSummary {
    pub agent: String,
    pub status: String,
    pub model: String,
    pub session_file: String, // 下钻子会话的权威路径 (缺失则该 step 不可下钻)
    pub duration_ms: u64,
    pub tokens: u64, // step.tokens.total, workflow 模式无 → 0
    pub error: String,
    pub recent_output: Vec<String>, // 末 30 行文本 (天然适合进度展示)
    pub active_tools: Vec<FleetActiveTool>, // 进行中的工具调用; 空 = 思考中/不可读 (安静降级)
    pub session_tail_at: u64, // 子会话尾读的时间戳 (ms); 0 = 未读到
    pub children: Vec<FleetStepSummary>, // 子 agent 再 fanout 时的嵌套 run (R2 递归渲染, 通常为空)
}

/// 进行中的工具调用 (未配对的 toolCall)。可能多个 —— 一条 assistant message 可并行发多个。
#[derive(Serialize, Clone, PartialEq)]
pub struct FleetActiveTool {
    pub name: String,    // bash | read | edit | ...
    pub summary: String, // 参数摘要, 已截断
    pub done: bool,      // true = 窗口内已配对 (刚完成), false = 进行中
}

/// 单个 run 的精简摘要 (舰队面板列表行 + 活动区/历史区共用)。
/// 字段名 snake_case 直达前端 (与 session_fs 前端约定一致, 不转 camelCase)。
#[derive(Serialize, Clone, PartialEq)]
pub struct FleetRunSummary {
    pub run_id: String,
    pub dir: String, // run 目录绝对路径, 前端传回 read_fleet_run_detail 用 (不重算)
    pub mode: String,        // "single" | "workflow" | ...
    pub state: String,       // "running" | "complete" | "failed" | ...
    pub started_at: u64,     // epoch ms
    pub last_update: u64,
    pub ended_at: u64, // ==0 表示未结束 (活动态判据之一)
    pub duration_ms: u64,
    pub cwd: String,
    pub total_tokens: u64,   // totalTokens.total
    pub total_cost_usd: f64, // totalCost.costUsd
    pub turn_count: u64,
    pub tool_count: u64,
    pub error: String,
    pub current_step: u64, // single 模式有 (currentStep), workflow 模式无
    pub active: bool,      // 前端分活动区/历史区用
    pub steps: Vec<FleetStepSummary>,
    pub session_file: String, // 顶层 sessionFile (step 缺失时下钻兜底)
    // 主会话 uuid: 从 status.json 的 sessionId(主会话 jsonl 文件路径)解析, 会话锚定用。
    // 空串 = 缺失/畸形, 该 run 在「本会话」视图视为不归属, 「全部」仍可见 (R5 宁漏勿误)。
    pub session_id: String,
}

#[derive(Serialize)]
pub struct FleetSnapshot {
    pub runs: Vec<FleetRunSummary>,
}

#[derive(Serialize, Debug)]
pub struct FleetRunDetail {
    pub status: Value,       // status.json 原始 Value (前端自行取需要的字段)
    pub events: Vec<Value>, // events.jsonl 尾部 50 条 (逐行 JSON, 坏行跳过)
}

// 已知终态集合: 命中即视为非活动 (活动判据 = endedAt==0 且 state 非终态)。
// 用 endedAt 而非单纯 state 枚举: endedAt 是结构化时间戳, 上游新增中间态 (paused/
// needs_attention) 时 endedAt 仍为 0 → 自动识别为活动, 比 stringly-typed 枚举前向兼容好。
const TERMINAL_STATES: &[&str] = &[
    "complete", "completed", "fail", "failed", "aborted", "cancelled", "canceled",
    "stopped", "error", "done", "finished", "success", "succeeded",
];

// --- 宽松取字段 helpers (R5: 缺失/类型不符一律默认值, 不报错) ---

fn field_str(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn field_u64(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

// 时间戳统一 epoch ms: u64 直取, f64 (lastActivityAt 可能带小数) 截断为 u64。
// 字符串/无效类型 → 0 (实测未出现, 但留默认值兜底符合 R5)
fn field_ms(v: &Value, key: &str) -> u64 {
    v.get(key)
        .and_then(|x| {
            if let Some(n) = x.as_u64() {
                Some(n)
            } else if let Some(f) = x.as_f64() {
                Some(f as u64)
            } else {
                None
            }
        })
        .unwrap_or(0)
}

// duration 推导: 优先 durationMs; 缺省用 (endedAt|lastUpdate|lastActivityAt)-startedAt。
// run 级一般无 durationMs (在 step 里), 故 run 级走推算; step 级有 durationMs 直接用。
fn derive_duration(v: &Value, started: u64) -> u64 {
    let d = field_u64(v, "durationMs");
    if d > 0 {
        return d;
    }
    let end = {
        let e = field_ms(v, "endedAt");
        if e > 0 {
            e
        } else {
            let lu = field_ms(v, "lastUpdate");
            if lu > 0 {
                lu
            } else {
                field_ms(v, "lastActivityAt")
            }
        }
    };
    end.saturating_sub(started)
}

/// 从 status.json 的 sessionId(主会话 jsonl 文件路径)解析出会话 uuid。
/// 文件名形如 `<timestamp>Z_<uuid>.jsonl`: timestamp 用 `-`/`T`/`Z` 不含 `_`,
/// uuid 用 `-` 不含 `_`, 故文件名中唯一的 `_` 即 ts/uuid 分隔。取最后一个 `_` 之后、
/// 去 `.jsonl` 后缀即 uuid。缺失/畸形/非常规文件名 → 空串 (宁漏勿误, 不造半截 uuid 误匹配)。
fn parse_session_uuid(raw: &str) -> String {
    // rsplit(['/','\\']).next() 取文件名 (跨平台分隔符, 处理 Windows/Unix 路径)
    let Some(stem) = raw.rsplit(['/', '\\']).next() else {
        return String::new();
    };
    // rsplit_once('_') 取 ts 之后部分; 无 `_` → 非常规文件名 → 空串
    let Some((_, uuid_with_ext)) = stem.rsplit_once('_') else {
        return String::new();
    };
    // 必须是 .jsonl 后缀, 否则空串 (防 `a_b.txt` 这类误造 uuid)
    uuid_with_ext
        .strip_suffix(".jsonl")
        .unwrap_or("")
        .to_string()
}

fn parse_step(s: &Value) -> Option<FleetStepSummary> {
    // recentOutput 取末 30 行 (全量放开有内存风险, 30 行足够卡片滚动展示)
    let recent: Vec<String> = s
        .get("recentOutput")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let recent = if recent.len() > 30 {
        recent[recent.len() - 30..].to_vec()
    } else {
        recent
    };
    Some(FleetStepSummary {
        agent: field_str(s, "agent"),
        status: field_str(s, "status"),
        model: field_str(s, "model"),
        session_file: field_str(s, "sessionFile"),
        duration_ms: derive_duration(s, field_ms(s, "startedAt")),
        tokens: s
            .get("tokens")
            .and_then(|t| t.get("total"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        error: field_str(s, "error"),
        recent_output: recent,
        // active_tools / session_tail_at 由 scan_fleet_runs 对 active run 统一补读 (见 fill_active_tools),
        // 纯解析不触 IO —— 解析函数保持无副作用, 测试不依赖真实文件
        active_tools: Vec::new(),
        session_tail_at: 0,
        children: parse_steps(s.get("children")),
    })
}

fn parse_steps(steps_val: Option<&Value>) -> Vec<FleetStepSummary> {
    steps_val
        .and_then(|s| s.as_array())
        .map(|arr| arr.iter().filter_map(parse_step).collect())
        .unwrap_or_default()
}

/// 解析单个 run 的 status.json 为摘要。任何字段缺失/类型不符给默认值, 永不返回 None
/// (除非 status 根本不是 object —— 那是彻底损坏的产物, 跳过)。
fn parse_run(dir: &Path, status: &Value) -> Option<FleetRunSummary> {
    if !status.is_object() {
        return None;
    }
    let started = field_ms(status, "startedAt");
    let last_update = field_ms(status, "lastUpdate");
    let ended = field_ms(status, "endedAt");
    let state = field_str(status, "state");
    // 活动判据: 未结束 (endedAt==0) 且 state 非终态。两者都满足才算活动 ——
    // 防止 "state=complete 但 endedAt 异常为 0" 的坏数据被误判为活动
    let active = ended == 0 && !TERMINAL_STATES.contains(&state.as_str());
    Some(FleetRunSummary {
        run_id: field_str(status, "runId"),
        dir: dir.to_string_lossy().to_string(),
        mode: field_str(status, "mode"),
        state,
        started_at: started,
        last_update,
        ended_at: ended,
        duration_ms: derive_duration(status, started),
        cwd: field_str(status, "cwd"),
        total_tokens: status
            .get("totalTokens")
            .and_then(|t| t.get("total"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        total_cost_usd: status
            .get("totalCost")
            .and_then(|c| c.get("costUsd"))
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0),
        turn_count: field_u64(status, "turnCount"),
        tool_count: field_u64(status, "toolCount"),
        error: field_str(status, "error"),
        current_step: field_u64(status, "currentStep"),
        active,
        steps: parse_steps(status.get("steps")),
        session_file: field_str(status, "sessionFile"),
        session_id: parse_session_uuid(&field_str(status, "sessionId")),
    })
}

/// 扫描 base 下的 `pi-subagents-*/async-subagent-runs/*/status.json`, 宽松解析为摘要。
/// 多 scope 全扫, 空目录/坏 JSON/非 scope 目录静默跳过, 单 run 解析失败只跳过该 run。
/// 返回未排序 (排序由 list_fleet_runs 统一做); 抽出为 pub(crate) 便于集成测试 (不依赖真实 tmp)。
pub(crate) fn scan_fleet_runs(base: &Path) -> Vec<FleetRunSummary> {
    let mut runs = Vec::new();
    // 列 base 下所有 pi-subagents-* scope 目录 (可能多个, 见模块头注释)
    let Ok(scope_entries) = std::fs::read_dir(base) else {
        return runs; // base 不可读 → 空 (非错误)
    };
    for scope in scope_entries.flatten() {
        if !scope.file_name().to_string_lossy().starts_with("pi-subagents-") {
            continue;
        }
        let runs_dir = scope.path().join("async-subagent-runs");
        let Ok(run_entries) = std::fs::read_dir(&runs_dir) else {
            continue; // 该 scope 无 async-subagent-runs 子目录, 跳过
        };
        for run in run_entries.flatten() {
            let run_dir = run.path();
            let status_path = run_dir.join("status.json");
            if !status_path.is_file() {
                continue; // 空目录 (无 status.json) 静默跳过 (design: 如 133aa0e2)
            }
            // 读 + 解析, 任何一步失败都只跳过该 run, 不影响其余
            let Ok(content) = std::fs::read_to_string(&status_path) else {
                continue;
            };
            let Ok(status) = serde_json::from_str::<Value>(&content) else {
                continue; // 坏 JSON: 该 run 降级跳过, 其余正常展示 (R5)
            };
            if let Some(mut summary) = parse_run(&run_dir, &status) {
                // 仅活动 run 补读子会话尾 (进行中的工具调用)。历史终态 run 不触 IO ——
                // 尾读是对运行中文档流的实时观察, 对已结束的 run 没有意义
                if summary.active {
                    fill_active_tools(&mut summary);
                }
                runs.push(summary);
            }
        }
    }
    runs
}

/// 反向读文件尾部窗口并解析 toolCall 配对。窗口 64 KB (见 design): 覆盖最近数十条消息,
/// 单条超长消息被窗口切断可接受 —— 下一轮工具调用会重新进入窗口。
const TAIL_WINDOW_BYTES: u64 = 64 * 1024;

/// 对活动 run 的每个 step 补读子会话尾: 找未配对的 toolCall (进行中工具) + 尾读时间戳。
/// 子会话路径只从 steps[].session_file 取 (design 关键约束, 禁止自行拼接 —— scope 重算会错)。
/// 文件不可读/坏行 → active_tools 留空, 安静降级 (PRD A6)。
fn fill_active_tools(run: &mut FleetRunSummary) {
    let fill = |step: &mut FleetStepSummary| {
        if step.session_file.is_empty() {
            return; // 无 sessionFile → 不可下钻也不可尾读
        }
        let path = PathBuf::from(&step.session_file);
        // mtime 取值 (与 session_fs::get_session_file_mtime 同款)
        step.session_tail_at = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if step.session_tail_at == 0 {
            return; // 文件不可读 → 不尾读
        }
        step.active_tools = read_active_tools(&path);
    };
    for step in &mut run.steps {
        fill(step);
        for child in &mut step.children {
            fill(child);
        }
    }
}

/// 尾读子会话 session.jsonl, 配对 toolCall/toolResult, 返回进行中的工具。
/// 规则 (design): 窗口内未配对的 toolCall = 进行中; 全部配对 → 取最后一个已完成并标 done。
fn read_active_tools(path: &Path) -> Vec<FleetActiveTool> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let Ok(file_len) = file.metadata().map(|m| m.len()) else {
        return Vec::new();
    };
    // 反向窗口: 从尾部 seek 回 TAIL_WINDOW_BYTES, 不足则从头
    let start = file_len.saturating_sub(TAIL_WINDOW_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::with_capacity(TAIL_WINDOW_BYTES as usize);
    if file.take(TAIL_WINDOW_BYTES).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let content = String::from_utf8_lossy(&buf);
    // 按行切: 仅当窗口起点在文件中部 (start>0) 时首行才是半行需丢弃;
    // 文件不足窗口大小时从文件头读, 首行完整, 不能删
    let mut lines: Vec<&str> = content.split('\n').collect();
    if start > 0 && lines.len() > 1 {
        lines.remove(0); // 丢弃窗口首行 (半行)
    }
    // 末行: split('\n') 在文件以 \n 结尾时末元素为空串, 否则是写入中的半行 —— 都丢弃
    if matches!(lines.last(), Some(l) if l.is_empty() || !content.ends_with('\n')) {
        lines.pop();
    }
    if lines.is_empty() {
        return Vec::new();
    }
    // 扫描: 收集 toolCall (id → name,args) 与 toolResult (toolCallId set)
    #[derive(Clone)]
    struct PendingTool {
        name: String,
        summary: String,
    }
    let mut pending: Vec<(String, PendingTool)> = Vec::new(); // (id, tool) 保持顺序
    let mut done_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 坏行/半行跳过 (R5)
        };
        // 定位 content 数组里的 toolCall (assistant message) 或顶层 toolResult
        let msg = v.get("message");
        let role = msg.and_then(|m| m.get("role")).and_then(|r| r.as_str());
        if role == Some("assistant") {
            if let Some(content) = msg.and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                for item in content {
                    if item.get("type").and_then(|t| t.as_str()) != Some("toolCall") {
                        continue;
                    }
                    let Some(id) = item.get("id").and_then(|x| x.as_str()) else {
                        continue;
                    };
                    let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("");
                    pending.push((
                        id.to_string(),
                        PendingTool {
                            name: name.to_string(),
                            summary: tool_summary(name, item.get("arguments")),
                        },
                    ));
                }
            }
        } else if let Some(tid) = v.get("toolCallId").and_then(|x| x.as_str()) {
            // toolResult 行 (顶层或 message 内): 回指配对
            done_ids.insert(tid.to_string());
        }
    }
    // 结果: 未配对 = 进行中; 全部配对时取最后一个工具标 done (design: 避免卡片空白,
    // 子代理正在输出/思考, 展示「刚完成」的工具更连贯)
    if !pending.is_empty() {
        let unfinished: Vec<FleetActiveTool> = pending
            .iter()
            .filter(|(id, _)| !done_ids.contains(id))
            .map(|(_, t)| FleetActiveTool {
                name: t.name.clone(),
                summary: t.summary.clone(),
                done: false,
            })
            .collect();
        if !unfinished.is_empty() {
            return unfinished;
        }
        // 窗口内全部配对: 取最后一个工具标 done
        let last = pending.last().unwrap();
        return vec![FleetActiveTool {
            name: last.1.name.clone(),
            summary: last.1.summary.clone(),
            done: true,
        }];
    }
    Vec::new()
}

/// 按工具名提取单字段参数摘要 (design 表): bash→command 首行; read/write/edit→path 尾两段;
/// grep/glob→pattern; 其他工具仅名字 (summary 空, 由前端只显名)。
fn tool_summary(name: &str, args: Option<&Value>) -> String {
    let Some(args) = args else { return String::new() };
    let pick = |key: &str| args.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let truncate = |s: String, n: usize| {
        if s.chars().count() > n {
            let cut: String = s.chars().take(n).collect();
            format!("{cut}…")
        } else {
            s
        }
    };
    let path_tail = |p: &str| {
        // 路径尾部两段
        let segs: Vec<&str> = p.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
        if segs.len() >= 2 {
            format!("…/{}/{}", segs[segs.len() - 2], segs[segs.len() - 1])
        } else {
            segs.last().map(|s| s.to_string()).unwrap_or_default()
        }
    };
    match name {
        "bash" => truncate(pick("command").lines().next().unwrap_or("").to_string(), 60),
        "read" | "write" | "edit" => truncate(path_tail(&pick("path")), 60),
        "grep" | "glob" => truncate(pick("pattern"), 60),
        _ => String::new(), // 未知工具不猜字段, 只显名字
    }
}

/// 列出所有 subagent run 的精简摘要。多 scope glob 全扫, 空目录静默跳过,
/// 单 run 解析失败只跳过该 run。目录不存在/无匹配 → 空数组 (非错误, 安静降级)。
#[tauri::command]
pub fn list_fleet_runs() -> Result<FleetSnapshot, String> {
    let mut runs = scan_fleet_runs(&std::env::temp_dir());
    // 排序: 活动在前, 同组内按 last_update 降序 (最近活动的优先)。
    // active 之间也按 last_update 降序 → 刚更新的活动 run 排最前
    runs.sort_by(|a, b| match (a.active, b.active) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => b.last_update.cmp(&a.last_update),
    });
    Ok(FleetSnapshot { runs })
}

/// 读取单个 run 的详情: status.json 原始 Value + events.jsonl 尾部 50 条。
/// 入参 run_dir 为 run 目录绝对路径 (前端从 summary.dir 拿, 不重算)。
/// 路径安全: 必须在 temp_dir() 之下且路径含 `pi-subagents-` 前缀目录 (防任意路径读)。
#[tauri::command]
pub fn read_fleet_run_detail(run_dir: String) -> Result<FleetRunDetail, String> {
    let tmp = std::env::temp_dir();
    let dir = PathBuf::from(&run_dir);
    // canonicalize 解析符号链接/相对段; 失败时回退原始路径 (目录可能刚被删, 交给后续读文件报错)
    let canon = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let tmp_canon = tmp.canonicalize().unwrap_or(tmp);
    if !canon.starts_with(&tmp_canon) {
        return Err(format!("产物目录不在临时目录下: {run_dir}"));
    }
    // 路径组件必须含 pi-subagents- 前缀目录, 防读 tmp 下任意子目录
    let has_scope = canon
        .components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with("pi-subagents-"));
    if !has_scope {
        return Err(format!("非法产物目录: {run_dir}"));
    }

    let status_path = canon.join("status.json");
    let status = std::fs::read_to_string(&status_path)
        .map_err(|e| format!("读取 status.json 失败: {e}"))?
        .parse::<Value>()
        .map_err(|e| format!("解析 status.json 失败: {e}"))?;

    let events = read_events_tail(&canon.join("events.jsonl"), 50);
    Ok(FleetRunDetail { status, events })
}

/// 读 events.jsonl 尾部 N 条, 逐行 JSON, 坏行/空行跳过 (R5)。
/// events 是 append-only 诊断流, 全量无价值, 时间线展示只需最近事件 (design)。
pub(crate) fn read_events_tail(path: &Path, n: usize) -> Vec<Value> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return vec![]; // 无 events.jsonl → 空 (非错误, 有些 run 只写 status)
    };
    let lines: Vec<&str> = content.lines().collect();
    let tail = if lines.len() > n { &lines[lines.len() - n..] } else { &lines[..] };
    tail.iter()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() {
                None
            } else {
                serde_json::from_str::<Value>(l).ok() // 坏行跳过 (R5: 单行失败不阻断)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 完整字段样本 (对照真实 1fb8c2c6 failed run 结构)
    const FULL_STATUS: &str = r#"{
      "lifecycleArtifactVersion": 1,
      "runId": "1fb8c2c6-ddc1-4eab-87ee-6d2d403d23e3",
      "mode": "single",
      "state": "failed",
      "startedAt": 1783923584625,
      "lastUpdate": 1783923950714,
      "endedAt": 1783923950714,
      "cwd": "C:\\workspace\\hanjiang\\zkyTool",
      "currentStep": 0,
      "totalTokens": {"input": 201605, "output": 12758, "total": 214363},
      "totalCost": {"inputTokens": 201605, "outputTokens": 12758, "costUsd": 0.9846625},
      "turnCount": 11,
      "toolCount": 55,
      "error": "Step failed: reviewer",
      "sessionFile": "C:\\Users\\han\\.pi\\agent\\sessions\\x\\run-0\\session.jsonl",
      "steps": [{
        "agent": "reviewer", "status": "failed", "model": "YuKiCodex/gpt-5.6-sol:high",
        "sessionFile": "C:\\Users\\han\\.pi\\agent\\sessions\\x\\run-0\\session.jsonl",
        "startedAt": 1783923584635, "endedAt": 1783923950710, "durationMs": 366075,
        "tokens": {"input": 201605, "output": 12758, "total": 214363},
        "error": "Acceptance rejected",
        "recentOutput": ["line1", "line2", "line3", "line4", "line5", "line6"]
      }]
    }"#;

    #[test]
    fn parse_full_run_all_fields() {
        let v: Value = serde_json::from_str(FULL_STATUS).unwrap();
        let s = parse_run(Path::new("/tmp/pi-subagents-x/async-subagent-runs/1fb8c2c6"), &v).unwrap();
        assert_eq!(s.run_id, "1fb8c2c6-ddc1-4eab-87ee-6d2d403d23e3");
        assert_eq!(s.mode, "single");
        assert_eq!(s.state, "failed");
        assert_eq!(s.started_at, 1783923584625);
        assert_eq!(s.ended_at, 1783923950714);
        // run 级无 durationMs → derive_duration 走推算: endedAt - startedAt = 365089
        assert_eq!(s.duration_ms, 1783923950714u64 - 1783923584625);
        assert!(!s.active); // failed 终态
        assert_eq!(s.total_tokens, 214363);
        assert!((s.total_cost_usd - 0.9846625).abs() < 1e-9);
        assert_eq!(s.error, "Step failed: reviewer");
        assert_eq!(s.steps.len(), 1);
        let st = &s.steps[0];
        assert_eq!(st.agent, "reviewer");
        assert_eq!(st.duration_ms, 366075); // step 有 durationMs 直接用
        assert_eq!(st.tokens, 214363);
        assert_eq!(st.recent_output.len(), 6); // 截断上限 30, 6 行全保留
        assert_eq!(st.recent_output.last().unwrap(), "line6");
        // FULL_STATUS 无 sessionId 字段 → session_id 空串 (R5: 缺失不误匹配)
        assert_eq!(s.session_id, "");
    }

    #[test]
    fn parse_run_extracts_session_id_uuid() {
        // status.json 的 sessionId 是主会话 jsonl 文件路径, 取文件名 `<ts>_<uuid>.jsonl` 的 uuid 段
        let v = serde_json::json!({
            "runId": "r1", "state": "complete",
            "sessionId": r"C:\Users\u\.pi\agent\sessions\--C--x--\2026-07-13T02-28-02-202Z_019f594d-8c1a-78ac-a11b-188a5cd6cd75.jsonl"
        });
        let s = parse_run(Path::new("/tmp/x"), &v).unwrap();
        assert_eq!(s.session_id, "019f594d-8c1a-78ac-a11b-188a5cd6cd75");
        // Unix 风格分隔符同样解析
        let v = serde_json::json!({
            "runId": "r2", "state": "complete",
            "sessionId": "/home/u/.pi/agent/sessions/x/2026-08-18T08-24-19-171Z_01a013f8-abe3-7148-8549-e19b7a3a521b.jsonl"
        });
        assert_eq!(parse_run(Path::new("/tmp/x"), &v).unwrap().session_id, "01a013f8-abe3-7148-8549-e19b7a3a521b");
    }

    #[test]
    fn parse_session_uuid_handles_irregular() {
        // 正常路径
        assert_eq!(parse_session_uuid(r"C:\x\2026-07-13T02-28-02-202Z_abc-123.jsonl"), "abc-123");
        // 空 → 空
        assert_eq!(parse_session_uuid(""), "");
        // 无 `_` 分隔
        assert_eq!(parse_session_uuid("foo.jsonl"), "");
        // 有 `_` 但非 .jsonl
        assert_eq!(parse_session_uuid("a_b.txt"), "");
        // 无扩展名
        assert_eq!(parse_session_uuid("no_ext"), "");
        // 末段是目录名 (无合法结构)
        assert_eq!(parse_session_uuid("/path/to/some_dir"), "");
    }

    #[test]
    fn parse_missing_fields_default_no_panic() {
        // 极简 status: 只有 runId + state, 其余全缺 → 默认值, 不报错
        let v: Value = serde_json::from_str(r#"{"runId":"abc","state":"running"}"#).unwrap();
        let s = parse_run(Path::new("/tmp/x"), &v).unwrap();
        assert_eq!(s.run_id, "abc");
        assert_eq!(s.state, "running");
        assert_eq!(s.mode, "");
        assert_eq!(s.started_at, 0);
        assert_eq!(s.ended_at, 0);
        assert!(s.active); // endedAt==0 且 state=running 非终态 → 活动
        assert_eq!(s.total_tokens, 0);
        assert!((s.total_cost_usd - 0.0).abs() < 1e-9);
        assert!(s.steps.is_empty());
        assert_eq!(s.session_file, "");
    }

    #[test]
    fn parse_type_drift_timestamps() {
        // startedAt 是无效字符串 → 0; lastActivityAt 是 f64 带小数 → 截断 u64
        let v: Value = serde_json::from_str(
            r#"{"runId":"x","state":"running","startedAt":"oops","lastActivityAt":1783923949701.9446}"#,
        )
        .unwrap();
        let s = parse_run(Path::new("/tmp/x"), &v).unwrap();
        assert_eq!(s.started_at, 0);
        // 无 endedAt/lastUpdate → duration 走 lastActivityAt - started = 1783923949701
        assert_eq!(s.duration_ms, 1783923949701);
        assert_eq!(s.last_update, 0);
    }

    #[test]
    fn parse_non_object_skipped() {
        // status 根不是 object (彻底损坏) → None, 调用方跳过该 run
        let v: Value = serde_json::from_str(r#"[1,2,3]"#).unwrap();
        assert!(parse_run(Path::new("/tmp/x"), &v).is_none());
        let v: Value = serde_json::from_str(r#""just a string""#).unwrap();
        assert!(parse_run(Path::new("/tmp/x"), &v).is_none());
    }

    #[test]
    fn active_only_when_unfinished_and_non_terminal() {
        // endedAt==0 + 终态 state → 非活动 (防坏数据误判)
        let v: Value = serde_json::from_str(r#"{"runId":"a","state":"complete"}"#).unwrap();
        assert!(!parse_run(Path::new("/tmp/x"), &v).unwrap().active);
        // endedAt==0 + 中间态 paused → 活动
        let v: Value = serde_json::from_str(r#"{"runId":"b","state":"paused"}"#).unwrap();
        assert!(parse_run(Path::new("/tmp/x"), &v).unwrap().active);
        // endedAt 有值 + running → 非活动 (已结束)
        let v: Value = serde_json::from_str(r#"{"runId":"c","state":"running","endedAt":100}"#).unwrap();
        assert!(!parse_run(Path::new("/tmp/x"), &v).unwrap().active);
    }

    #[test]
    fn sort_active_first_then_last_update_desc() {
        let mk = |id: &str, active: bool, lu: u64| FleetRunSummary {
            run_id: id.into(), dir: "".into(), mode: "".into(), state: "".into(),
            started_at: 0, last_update: lu, ended_at: 0, duration_ms: 0, cwd: "".into(),
            total_tokens: 0, total_cost_usd: 0.0, turn_count: 0, tool_count: 0,
            error: "".into(), current_step: 0, active, steps: vec![], session_file: "".into(),
            session_id: "".into(),
        };
        let mut runs = vec![
            mk("old_hist", false, 100),
            mk("active2", true, 200),
            mk("new_hist", false, 300),
            mk("active1", true, 500),
        ];
        runs.sort_by(|a, b| match (a.active, b.active) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => b.last_update.cmp(&a.last_update),
        });
        assert_eq!(runs[0].run_id, "active1"); // 活动组内 last_update 降序
        assert_eq!(runs[1].run_id, "active2");
        assert_eq!(runs[2].run_id, "new_hist"); // 历史组内 last_update 降序
        assert_eq!(runs[3].run_id, "old_hist");
    }

    #[test]
    fn read_events_tail_truncates_and_skips_bad_lines() {
        // 写一个含坏行 + 超过 N 行的 events.jsonl 到临时文件
        let dir = std::env::temp_dir().join("pi-fleet-test-events");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        let mut content = String::new();
        for i in 0..60 {
            content.push_str(&format!("{{\"ts\":{},\"type\":\"ok\"}}\n", i));
        }
        content.push_str("NOT JSON\n"); // 坏行
        content.push_str("\n"); // 空行
        content.push_str("{\"ts\":999,\"type\":\"last\"}\n");
        std::fs::write(&path, content).unwrap();

        let tail = read_events_tail(&path, 50);
        // 60 ok + 1 bad + 1 empty + 1 last = 63 lines; tail 50 takes last 50 lines
        // (bad+empty skipped) = 48 valid JSON entries
        assert_eq!(tail.len(), 48);
        // 最后一条是末行 {"ts":999}
        assert_eq!(tail.last().unwrap().get("ts").unwrap().as_u64(), Some(999));
        // 坏行没进结果
        assert!(tail.iter().all(|v| v.get("type").is_some()));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_events_missing_file_returns_empty() {
        let path = std::env::temp_dir().join("pi-fleet-no-such-events.jsonl");
        let tail = read_events_tail(&path, 50);
        assert!(tail.is_empty()); // 无文件 → 空 (非错误)
    }

    #[test]
    fn detail_path_rejects_outside_tmp() {
        // read_fleet_run_detail 路径校验: 不在 temp_dir 下 / 无 pi-subagents- 前缀 → 拒绝
        let bogus = if cfg!(windows) {
            "C:\\Windows\\System32\\pi-subagents-x\\async-subagent-runs\\run1"
        } else {
            "/etc/pi-subagents-x/async-subagent-runs/run1"
        };
        let err = read_fleet_run_detail(bogus.to_string()).unwrap_err();
        assert!(err.contains("不在临时目录下") || err.contains("非法产物目录"));
    }

    // 集成测试: 真实目录扫描逻辑 (多 scope / 空目录 / 坏 JSON / 非 scope 目录跳过)。
    // 不依赖本机 tmp, 自建临时目录树验证 scan_fleet_runs 的遍历 + 跳过策略 (PRD R4 + R5)。
    #[test]
    fn scan_multi_scope_skips_empty_bad_and_non_scope() {
        let base = std::env::temp_dir().join(format!("pi-fleet-scan-test-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok(); // 清理可能残留
        let mk = |scope: &str, run: &str, status: Option<&str>| {
            let d = base.join(scope).join("async-subagent-runs").join(run);
            std::fs::create_dir_all(&d).unwrap();
            if let Some(s) = status {
                std::fs::write(d.join("status.json"), s).unwrap();
            }
        };
        mk("pi-subagents-scopeA", "run1", Some(
            r#"{"runId":"run1","state":"complete","startedAt":100,"lastUpdate":200,"endedAt":200}"#,
        ));
        mk("pi-subagents-scopeA", "run2-empty", None); // 空目录 (无 status.json) → 跳过
        mk("pi-subagents-scopeB", "run3", Some(
            r#"{"runId":"run3","state":"failed","startedAt":50,"lastUpdate":300,"endedAt":300,"error":"boom"}"#,
        ));
        mk("pi-subagents-scopeB", "run4-bad", Some("NOT JSON")); // 坏 JSON → 跳过
        mk("non-pi-subagents-dir", "runX", Some(r#"{"runId":"x"}"#)); // 非 scope 目录 → 跳过

        let runs = scan_fleet_runs(&base);
        assert_eq!(runs.len(), 2); // 仅 run1 + run3 有效
        let ids: Vec<&str> = runs.iter().map(|r| r.run_id.as_str()).collect();
        assert!(ids.contains(&"run1"));
        assert!(ids.contains(&"run3"));
        assert!(!ids.contains(&"x")); // 非 scope 目录被跳过

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn parse_step_children_nested() {
        // 子 agent 再 fanout: step 内嵌 children, 递归解析层级不塌陷 (PRD R2)
        let v: Value = serde_json::from_str(
            r#"{"runId":"x","state":"running","steps":[{"agent":"orch","status":"running","children":[{"agent":"w1","status":"complete","children":[{"agent":"gc","status":"complete"}]}]}]}"#,
        ).unwrap();
        let s = parse_run(Path::new("/tmp/x"), &v).unwrap();
        assert_eq!(s.steps.len(), 1);
        assert_eq!(s.steps[0].agent, "orch");
        assert_eq!(s.steps[0].children.len(), 1);
        assert_eq!(s.steps[0].children[0].agent, "w1");
        assert_eq!(s.steps[0].children[0].children.len(), 1);
        assert_eq!(s.steps[0].children[0].children[0].agent, "gc");
        assert!(s.steps[0].children[0].children[0].children.is_empty()); // 叶子节点无 children
    }

    // 真实 tmp 扫描冒烟 (手动: cargo test scan_real_tmp_smoke -- --ignored --nocapture)
    // 验证 R4: 多 scope 目录发现兜底能扫到本机真实 run。依赖本机环境, 默认 ignore。
    #[test]
    #[ignore]
    fn scan_real_tmp_smoke() {
        let runs = scan_fleet_runs(&std::env::temp_dir());
        eprintln!("[scan_real_tmp] 发现 {} 个 run", runs.len());
        for r in runs.iter().take(5) {
            eprintln!("  {} state={} active={} steps={}", r.run_id, r.state, r.active, r.steps.len());
        }
        // 本机应有 14+ 历史 run (design 一 实测), 至少扫到 1 个
        assert!(runs.len() >= 1, "本机 tmp 应有 subagent 产物, 实际扫到 {} 个", runs.len());
    }
    // --- read_active_tools: 子会话尾读与工具配对 ---

    /// 写临时子会话文件, 返回路径 (测试后由调用方清理)。
    /// 目录含测试名: 并行测试互不踩踏 (同 pid 同路径会互相删目录)
    fn write_temp_session(tag: &str, lines: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fleet_tail_{}_{}", std::process::id(), tag));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("session.jsonl");
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        p
    }

    const TOOLCALL_LINE: &str = r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls -la"}}]}}"#;
    const TOOLCALL_READ: &str = r#"{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"t2","name":"read","arguments":{"path":"C:\\workspace\\demo\\src\\main.rs"}}]}}"#;
    const TOOLRESULT_T1: &str = r#"{"type":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"done"}]}"#;

    #[test]
    fn active_tool_unpaired_identified() {
        // 末尾 toolCall 未配对 → 进行中
        let p = write_temp_session("unpaired", &[TOOLCALL_LINE]);
        let tools = read_active_tools(&p);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "bash");
        assert_eq!(tools[0].summary, "ls -la");
        assert!(!tools[0].done);
    }

    #[test]
    fn parallel_tools_all_returned() {
        // 同批并行 toolCall (bash + read) 都未配对 → 全部返回 (不只取第一个)
        let p = write_temp_session("parallel", &[TOOLCALL_LINE, TOOLCALL_READ]);
        let tools = read_active_tools(&p);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "bash");
        assert_eq!(tools[1].name, "read");
        assert!(tools[1].summary.contains("src/main.rs"), "summary 应含路径尾段: {}", tools[1].summary);
    }

    #[test]
    fn paired_tool_falls_back_to_last_done() {
        // toolCall 已配对 (toolResult 在窗口内) → 回落最后一个工具标 done
        let p = write_temp_session("paired", &[TOOLCALL_LINE, TOOLRESULT_T1]);
        let tools = read_active_tools(&p);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "bash");
        assert!(tools[0].done);
    }

    #[test]
    fn tail_half_line_and_bad_json_skipped() {
        // 尾部半行 (写入中) + 坏行 → 跳过不 panic, 正常行仍解析
        let p = write_temp_session("half", &[TOOLCALL_LINE, "this is not json", r#"{"type":"message","me"#]);
        let tools = read_active_tools(&p);
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "bash");
    }

    #[test]
    fn empty_or_missing_file_quiet() {
        // 文件不存在 → 空 Vec
        let missing = std::env::temp_dir().join(format!("fleet_tail_{}_missing.jsonl", std::process::id()));
        assert!(read_active_tools(&missing).is_empty());
        // 空文件 → 空 Vec
        let p = write_temp_session("empty", &[]);
        assert!(read_active_tools(&p).is_empty());
        std::fs::remove_dir_all(p.parent().unwrap()).ok();
    }
}
