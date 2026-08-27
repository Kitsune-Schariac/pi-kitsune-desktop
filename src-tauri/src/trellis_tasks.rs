//! Trellis 任务视图数据源: 只读扫描 `.trellis/tasks/` 任务树 + 当前活动任务指针。
//!
//! 与 pi 完全解耦 (PRD 独立性): 不接事件流、不发 RPC、不调 task.py (避免 Python 环境依赖
//! 与 ANSI 颜色码清洗), 直接读 task.json 与会话指针 JSON。
//!
//! 解析策略 (对齐 subagent_fleet 的 R5 宽松风格): serde_json::Value 读入后手动取字段,
//! 未知字段忽略、缺失给默认值而非报错; 单任务解析失败只跳过该任务, 绝不让整个列表失败;
//! `.trellis/` 不存在 → 空快照 + exists=false (R3: 大多数项目不用 Trellis, 降级是常态)。
//!
//! current 指针契约 (design §1, 复刻 Trellis 自身 `_resolve_single_session_fallback`):
//! 指针存于 `.trellis/.runtime/sessions/<context_key>.json`, 每个 AI 会话窗口各一份。
//! 恰好 1 个文件时读其 `current_task`; 0 或 ≥2 个 (多窗口) 都拒绝猜测返回 null ——
//! 标错「当前活动任务」比不标更糟, 与 Trellis 自身的拒绝猜测行为保持一致。

use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// 单个任务的精简摘要。字段名 snake_case 直达前端 (与 session_fs / fleet 约定一致)。
/// status/priority 等枚举值透传原始字符串, 上游 Trellis 升级新增状态时前端可自行兜底。
#[derive(Serialize, Clone, PartialEq)]
pub struct TrellisTaskSummary {
    pub dir: String,      // 任务目录名 (如 08-25-trellis-task-view), 树 key + 读产物入参
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,   // planning | in_progress | completed | ...(未知透传)
    pub priority: String, // P1 | P2 | ...
    pub assignee: String,
    pub parent: String,   // 父任务引用 (目录名/短名/路径, 前端宽容比对)
    pub children: Vec<String>,
    pub created_at: String,
    pub completed_at: String,
    pub has_prd: bool,
    pub has_design: bool,
    pub has_implement: bool,
    pub is_archived: bool,
}

#[derive(Serialize)]
pub struct TrellisTasksSnapshot {
    /// `.trellis/tasks/` 是否存在。前端药丸显隐判据: false → 入口不显示 (R3 安静隐藏,
    /// 比打开面板再看空态更少一步噪音)。区分「没装 Trellis」与「装了但无任务」。
    pub exists: bool,
    pub tasks: Vec<TrellisTaskSummary>,
    /// 恰好 1 个 session 文件时的 current_task 原始引用; 0/≥2 个 → null (多窗口不猜)。
    pub current_task_ref: Option<String>,
}

// --- 宽松取字段 helpers (缺失/类型不符一律默认值, 不报错) ---

fn field_str(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn field_str_vec(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// 解析单个 task.json。除根不是 object (彻底损坏) 外永不失败,
/// 字段缺失/类型不符全部默认值兜底 (schema 宽容, PRD 待解决未知之一)。
fn parse_task(dir_name: &str, dir: &Path, v: &Value, archived: bool) -> Option<TrellisTaskSummary> {
    if !v.is_object() {
        return None;
    }
    // title 缺失时回落 name 再回落目录名, 保证树行永远有可读文案
    let title = {
        let t = field_str(v, "title");
        if t.is_empty() {
            let n = field_str(v, "name");
            if n.is_empty() { dir_name.to_string() } else { n }
        } else {
            t
        }
    };
    Some(TrellisTaskSummary {
        dir: dir_name.to_string(),
        id: field_str(v, "id"),
        title,
        description: field_str(v, "description"),
        status: field_str(v, "status"),
        priority: field_str(v, "priority"),
        assignee: field_str(v, "assignee"),
        parent: field_str(v, "parent"),
        children: field_str_vec(v, "children"),
        created_at: field_str(v, "createdAt"),
        completed_at: field_str(v, "completedAt"),
        // 规划产物存在性: 轻量任务缺 design/implement 是合法状态 (PRD R2), 缺失非错误
        has_prd: dir.join("prd.md").is_file(),
        has_design: dir.join("design.md").is_file(),
        has_implement: dir.join("implement.md").is_file(),
        is_archived: archived,
    })
}

/// 扫描单个父目录下的一层任务目录 (含 task.json 的才算任务), 追加到 out。
fn collect_tasks_dir(parent: &Path, archived: bool, out: &mut Vec<TrellisTaskSummary>) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return; // 目录不可读 → 跳过 (非错误)
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let task_json = dir.join("task.json");
        if !dir.is_dir() || !task_json.is_file() {
            continue; // 无 task.json 的目录不是任务 (如 archive 月份容器), 静默跳过
        }
        let Ok(content) = std::fs::read_to_string(&task_json) else {
            continue; // 读失败: 该任务降级跳过, 其余正常展示
        };
        let Ok(v) = serde_json::from_str::<Value>(&content) else {
            continue; // 坏 JSON: 单任务跳过, 不影响其余 (宽松解析 + 静默降级)
        };
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if let Some(t) = parse_task(&dir_name, &dir, &v, archived) {
            out.push(t);
        }
    }
}

/// 扫描 tasks 根: 活动任务在根下一层, 归档任务在 archive/<YYYY-MM>/<dir> 两层。
/// 归档任务随主列表一并返回 (archived 标记), 前端决定显隐切换, 避免二次 IO。
/// 返回 (exists, tasks); 抽出为 pub(crate) 便于单测 (不依赖真实项目路径)。
pub(crate) fn scan_trellis_tasks(tasks_root: &Path) -> (bool, Vec<TrellisTaskSummary>) {
    let mut tasks = Vec::new();
    if !tasks_root.is_dir() {
        return (false, tasks); // 无 Trellis → 空快照 (R3 降级, 非错误)
    }
    collect_tasks_dir(tasks_root, false, &mut tasks);
    if let Ok(months) = std::fs::read_dir(tasks_root.join("archive")) {
        for month in months.flatten() {
            if month.path().is_dir() {
                collect_tasks_dir(&month.path(), true, &mut tasks);
            }
        }
    }
    (true, tasks)
}

/// 读当前活动任务指针: `.trellis/.runtime/sessions/*.json` 恰好 1 个时取 `current_task`。
/// 0 或 ≥2 个 → None (多窗口各持指针, Trellis 自身都拒绝猜测, GUI 遵循同一契约)。
fn read_current_task_ref(project_root: &Path) -> Option<String> {
    let sessions_dir = project_root.join(".trellis").join(".runtime").join("sessions");
    let Ok(entries) = std::fs::read_dir(&sessions_dir) else {
        return None; // 目录不存在 → None (无指针信息, 不标当前任务)
    };
    let files: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
        .collect();
    if files.len() != 1 {
        return None;
    }
    let Ok(content) = std::fs::read_to_string(&files[0]) else {
        return None;
    };
    let Ok(v) = serde_json::from_str::<Value>(&content) else {
        return None;
    };
    let r = field_str(&v, "current_task");
    if r.is_empty() { None } else { Some(r) }
}

/// 列出 Trellis 任务快照 (活动 + 归档 + current 指针)。
/// 打开面板拉一次 + 手动刷新, 不轮询 (任务状态变化频率极低且无机器事件源, design 关键决策)。
#[tauri::command]
pub fn list_trellis_tasks(cwd: String) -> Result<TrellisTasksSnapshot, String> {
    let project = Path::new(&cwd);
    let tasks_root = project.join(".trellis").join("tasks");
    let (exists, mut tasks) = scan_trellis_tasks(&tasks_root);
    // 排序: 归档在后; 同组内目录名倒序 (MM-DD 前缀字典序 = 时间倒序, 新任务在前)
    tasks.sort_by(|a, b| {
        a.is_archived
            .cmp(&b.is_archived)
            .then_with(|| b.dir.cmp(&a.dir))
    });
    let current_task_ref = read_current_task_ref(project);
    Ok(TrellisTasksSnapshot { exists, tasks, current_task_ref })
}

/// 读取单个任务的规划产物 (prd.md / design.md / implement.md 原文)。
/// doc 白名单三选一 (防通配文档读 + 路径穿越); 文件不存在 → 空串 (轻量任务合法状态,
/// 前端显示「未创建」占位而非错误); 任务目录不存在 (含归档后备也未命中) → 空串。
///
/// 路径安全: task_dir 必须是单段目录名 (不含分隔符/`..`), 定位顺序为
/// `tasks/<dir>` → `tasks/archive/<YYYY-MM>/<dir>` (归档后备, 让归档任务也能看产物),
/// 命中后 canonicalize 并强制限定在 `<cwd>/.trellis/tasks` 之下 (防符号链接逃逸)。
#[tauri::command]
pub fn read_trellis_task_doc(cwd: String, task_dir: String, doc: String) -> Result<String, String> {
    // doc 白名单: 只放行三个规划产物, 其余一律拒绝
    let file_name = match doc.as_str() {
        "prd" => "prd.md",
        "design" => "design.md",
        "implement" => "implement.md",
        _ => return Err(format!("未知文档类型: {doc}")),
    };
    // 单段目录名校验: 含分隔符或 . / .. 直接拒绝 (防路径穿越的第一道闸)
    if task_dir.is_empty()
        || task_dir.contains('/')
        || task_dir.contains('\\')
        || task_dir == "."
        || task_dir == ".."
    {
        return Err(format!("非法任务目录名: {task_dir}"));
    }
    let tasks_root = Path::new(&cwd).join(".trellis").join("tasks");
    if !tasks_root.is_dir() {
        return Ok(String::new()); // 无 Trellis → 空串 (R3 降级)
    }
    // 定位任务目录: 活动区优先, 未命中扫归档月份层
    let direct = tasks_root.join(&task_dir);
    let task_path = if direct.is_dir() {
        direct
    } else {
        let mut found = None;
        if let Ok(months) = std::fs::read_dir(tasks_root.join("archive")) {
            for month in months.flatten() {
                let cand = month.path().join(&task_dir);
                if cand.is_dir() {
                    found = Some(cand);
                    break;
                }
            }
        }
        match found {
            Some(p) => p,
            None => return Ok(String::new()), // 任务不存在 → 空串 (合法降级)
        }
    };
    // canonicalize 终检: 任务目录必须仍在 tasks 根之下 (防活动/归档目录被符号链接指出去)
    let root_canon = tasks_root
        .canonicalize()
        .map_err(|e| format!("tasks 目录不可达: {e}"))?;
    let task_canon = task_path
        .canonicalize()
        .map_err(|e| format!("任务目录不可达: {task_dir}: {e}"))?;
    if !task_canon.starts_with(&root_canon) {
        return Err(format!("任务目录越界: {task_dir}"));
    }
    // 文件不存在是轻量任务的合法状态 → 空串, 前端占位「未创建」 (PRD R2)
    match std::fs::read_to_string(task_canon.join(file_name)) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 隔离的临时基目录 (按测试名 + 进程 id, 避免并行测试互踩)
    fn temp_base(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("pi-trellis-test-{}-{}", name, std::process::id()));
        std::fs::remove_dir_all(&p).ok();
        p
    }

    // 完整 task.json 样本 (对照本仓库真实 task.json 22 字段结构)
    const FULL_TASK: &str = r#"{
      "id": "trellis-task-view", "name": "trellis-task-view",
      "title": "Trellis 任务视图", "description": "读 .trellis/tasks 文件系统",
      "status": "in_progress", "priority": "P2", "creator": "汉江", "assignee": "汉江",
      "createdAt": "2026-08-25", "completedAt": null,
      "branch": null, "base_branch": "master", "subtasks": [],
      "children": [], "parent": "08-25-gui-capability-expansion",
      "relatedFiles": [], "notes": "", "meta": {}
    }"#;

    #[test]
    fn parse_full_task_all_fields() {
        let v: Value = serde_json::from_str(FULL_TASK).unwrap();
        let t = parse_task("08-25-trellis-task-view", Path::new("/tmp/x"), &v, false).unwrap();
        assert_eq!(t.dir, "08-25-trellis-task-view");
        assert_eq!(t.id, "trellis-task-view");
        assert_eq!(t.title, "Trellis 任务视图");
        assert_eq!(t.status, "in_progress");
        assert_eq!(t.priority, "P2");
        assert_eq!(t.assignee, "汉江");
        assert_eq!(t.parent, "08-25-gui-capability-expansion");
        assert!(t.children.is_empty());
        assert_eq!(t.created_at, "2026-08-25");
        assert_eq!(t.completed_at, "");
        assert!(!t.is_archived);
    }

    #[test]
    fn parse_task_missing_fields_defaults() {
        // 极简 task.json: 字段大半缺失 → 全部默认值, 不报错 (PRD 验收: 字段缺失降级展示)
        let v: Value = serde_json::from_str(r#"{"id":"x"}"#).unwrap();
        let t = parse_task("08-01-x", Path::new("/tmp/x"), &v, false).unwrap();
        assert_eq!(t.id, "x");
        assert_eq!(t.title, "08-01-x"); // title/name 全缺 → 回落目录名
        assert_eq!(t.status, "");
        assert_eq!(t.priority, "");
        assert_eq!(t.parent, "");
        assert!(t.children.is_empty());
        assert!(!t.has_prd);
    }

    #[test]
    fn parse_task_title_falls_back_to_name() {
        let v: Value = serde_json::from_str(r#"{"id":"a","name":"named-task"}"#).unwrap();
        let t = parse_task("08-01-a", Path::new("/tmp/a"), &v, true).unwrap();
        assert_eq!(t.title, "named-task");
        assert!(t.is_archived);
    }

    #[test]
    fn parse_task_children_and_non_object() {
        // children 是字符串数组 → 原样收集; 非 string 元素跳过
        let v: Value = serde_json::from_str(r#"{"id":"p","children":["08-01-a","08-02-b",42]}"#).unwrap();
        let t = parse_task("parent", Path::new("/tmp/p"), &v, false).unwrap();
        assert_eq!(t.children, vec!["08-01-a", "08-02-b"]);
        // 根不是 object (彻底损坏) → None, 调用方跳过
        let v: Value = serde_json::from_str(r#"[1,2]"#).unwrap();
        assert!(parse_task("bad", Path::new("/tmp/bad"), &v, false).is_none());
    }

    #[test]
    fn scan_missing_dir_returns_not_exists() {
        let base = temp_base("scan-missing");
        let (exists, tasks) = scan_trellis_tasks(&base.join("no-such-tasks"));
        assert!(!exists);
        assert!(tasks.is_empty());
    }

    // 集成扫描: 活动 + 归档 + 坏 JSON / 无 task.json 目录跳过 (PRD 容错验收)
    #[test]
    fn scan_tasks_skips_bad_and_collects_archive() {
        let base = temp_base("scan-mixed");
        let tasks_root = base.join(".trellis").join("tasks");
        // 好任务 (带 prd.md)
        let good = tasks_root.join("08-25-good");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(good.join("task.json"), FULL_TASK).unwrap();
        std::fs::write(good.join("prd.md"), "# PRD").unwrap();
        // 坏 JSON → 跳过
        let bad = tasks_root.join("08-24-bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("task.json"), "NOT JSON").unwrap();
        // 无 task.json 的杂目录 → 跳过
        std::fs::create_dir_all(tasks_root.join("random-dir")).unwrap();
        // 归档任务 (两层) → 收集 + archived 标记
        let archived = tasks_root.join("archive").join("2026-07").join("07-01-old");
        std::fs::create_dir_all(&archived).unwrap();
        std::fs::write(
            archived.join("task.json"),
            r#"{"id":"old","title":"旧任务","status":"completed"}"#,
        ).unwrap();

        let (exists, tasks) = scan_trellis_tasks(&tasks_root);
        assert!(exists);
        assert_eq!(tasks.len(), 2); // good + archived, bad/random 跳过
        let good_t = tasks.iter().find(|t| t.dir == "08-25-good").unwrap();
        assert!(good_t.has_prd);
        assert!(!good_t.has_design); // 只有 prd.md
        assert!(!good_t.is_archived);
        let old = tasks.iter().find(|t| t.dir == "07-01-old").unwrap();
        assert!(old.is_archived);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn current_ref_zero_one_many_branches() {
        let base = temp_base("current-ref");
        let sessions = base.join(".trellis").join(".runtime").join("sessions");
        // 0 个 session 文件 (目录都没有) → None
        assert_eq!(read_current_task_ref(&base), None);
        std::fs::create_dir_all(&sessions).unwrap();
        // 仍 0 个 → None
        assert_eq!(read_current_task_ref(&base), None);
        // 恰好 1 个 → 读出 current_task
        std::fs::write(
            sessions.join("pi_process_a.json"),
            r#"{"platform":"pi","current_task":".trellis/tasks/08-25-trellis-task-view"}"#,
        ).unwrap();
        assert_eq!(
            read_current_task_ref(&base),
            Some(".trellis/tasks/08-25-trellis-task-view".to_string())
        );
        // 2 个 → 拒绝猜测 (多窗口不猜, design §1)
        std::fs::write(sessions.join("pi_process_b.json"), r#"{"current_task":"x"}"#).unwrap();
        assert_eq!(read_current_task_ref(&base), None);
        // 非 json 后缀不计数: 2 json + 1 txt 仍拒绝
        std::fs::write(sessions.join("notes.txt"), "not a session").unwrap();
        assert_eq!(read_current_task_ref(&base), None);
        // 删到只剩 1 个 json → 恢复读出
        std::fs::remove_file(sessions.join("pi_process_a.json")).unwrap();
        assert_eq!(read_current_task_ref(&base), Some("x".to_string()));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn current_ref_missing_or_bad_json_none() {
        let base = temp_base("current-ref-bad");
        let sessions = base.join(".trellis").join(".runtime").join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        // 坏 JSON → None
        std::fs::write(sessions.join("a.json"), "NOT JSON").unwrap();
        assert_eq!(read_current_task_ref(&base), None);
        // current_task 缺失/空 → None
        std::fs::write(sessions.join("a.json"), r#"{"platform":"pi"}"#).unwrap();
        assert_eq!(read_current_task_ref(&base), None);

        std::fs::remove_dir_all(&base).ok();
    }

    // 端到端: list command 在无 .trellis 项目 → exists=false 空快照 (R3)
    #[test]
    fn list_missing_project_degrades() {
        let base = temp_base("list-degrade");
        let snap = list_trellis_tasks(base.to_string_lossy().to_string()).unwrap();
        assert!(!snap.exists);
        assert!(snap.tasks.is_empty());
        assert_eq!(snap.current_task_ref, None);
    }

    // 端到端: 读产物三态 (存在 / 缺失空串 / 归档后备)
    #[test]
    fn read_doc_exists_missing_and_archive_fallback() {
        let base = temp_base("read-doc");
        let tasks_root = base.join(".trellis").join("tasks");
        let good = tasks_root.join("08-25-good");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(good.join("task.json"), FULL_TASK).unwrap();
        std::fs::write(good.join("prd.md"), "# PRD 内容\n- [x] done").unwrap();

        let cwd = base.to_string_lossy().to_string();
        // 存在 → 原文
        assert_eq!(
            read_trellis_task_doc(cwd.clone(), "08-25-good".into(), "prd".into()).unwrap(),
            "# PRD 内容\n- [x] done"
        );
        // 轻量任务缺 design/implement → 空串 (合法, 非错误)
        assert_eq!(read_trellis_task_doc(cwd.clone(), "08-25-good".into(), "design".into()).unwrap(), "");
        // 归档后备: archive/<YYYY-MM>/<dir> 也能读
        let archived = tasks_root.join("archive").join("2026-07").join("07-01-old");
        std::fs::create_dir_all(&archived).unwrap();
        std::fs::write(archived.join("task.json"), r#"{"id":"old"}"#).unwrap();
        std::fs::write(archived.join("implement.md"), "- [x] 已完成步骤").unwrap();
        assert_eq!(
            read_trellis_task_doc(cwd.clone(), "07-01-old".into(), "implement".into()).unwrap(),
            "- [x] 已完成步骤"
        );
        // 目录不存在 → 空串
        assert_eq!(read_trellis_task_doc(cwd, "08-99-nope".into(), "prd".into()).unwrap(), "");
    }

    #[test]
    fn read_doc_rejects_bad_inputs() {
        let base = temp_base("read-doc-reject");
        let good = base.join(".trellis").join("tasks").join("08-25-good");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(good.join("task.json"), FULL_TASK).unwrap();
        let cwd = base.to_string_lossy().to_string();
        // doc 白名单外 → Err
        assert!(read_trellis_task_doc(cwd.clone(), "08-25-good".into(), "../secret".into()).is_err());
        assert!(read_trellis_task_doc(cwd.clone(), "08-25-good".into(), "task.json".into()).is_err());
        // task_dir 含路径分隔符 / 点段 → Err
        assert!(read_trellis_task_doc(cwd.clone(), "../..".into(), "prd".into()).is_err());
        assert!(read_trellis_task_doc(cwd.clone(), "a/b".into(), "prd".into()).is_err());
        assert!(read_trellis_task_doc(cwd.clone(), "".into(), "prd".into()).is_err());
        // 正常调用仍通过 (拒绝逻辑没误伤)
        assert!(read_trellis_task_doc(cwd, "08-25-good".into(), "prd".into()).is_ok());
    }
}