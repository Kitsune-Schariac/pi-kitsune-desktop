//! 跨 Agent 统一任务清单 (TodoList / Plan) 领域模型与通用追踪器。
//!
//! 设计原则:
//! - 所有 Agent 的待办/计划协议差异封闭在后端, 前端仅消费统一 `PlanSnapshot`。
//! - `PlanTracker` 同时支持整表替换型 (ACP `plan` / Claude `TodoWrite` / Codex `update_plan` / Pi 扩展)
//!   与增量 CRUD 型 (Claude `TaskCreate` + `TaskUpdate`), 便于新接入 Agent 零重复代码复用。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// 单条任务状态 (跨 Rust / TS 契约统一 snake_case)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanItemStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl PlanItemStatus {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw
            .map(str::trim)
            .map(|s| s.to_ascii_lowercase())
            .as_deref()
        {
            Some("in_progress" | "in-progress" | "inprogress" | "running" | "active" | "doing") => {
                Self::InProgress
            }
            Some("completed" | "complete" | "done" | "finished") => Self::Completed,
            Some("cancelled" | "canceled" | "skipped") => Self::Cancelled,
            _ => Self::Pending,
        }
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::InProgress)
    }
}

/// 单条任务优先级 (ACP `PlanEntryPriority` 对齐)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanItemPriority {
    High,
    Medium,
    Low,
}

impl PlanItemPriority {
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        match raw
            .map(str::trim)
            .map(|s| s.to_ascii_lowercase())
            .as_deref()
        {
            Some("high" | "urgent" | "p0" | "p1") => Some(Self::High),
            Some("medium" | "normal" | "p2") => Some(Self::Medium),
            Some("low" | "p3") => Some(Self::Low),
            _ => None,
        }
    }
}

/// 统一任务清单单项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
    pub status: PlanItemStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<PlanItemPriority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_by: Vec<String>,
}

/// 统一任务清单快照 (整表推送给前端, `items` 为空表示清空清单)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub items: Vec<PlanItem>,
    pub source: String,
}

impl PlanSnapshot {
    /// 是否仍存在未完成 (`pending` / `in_progress`) 任务。
    pub fn has_incomplete(&self) -> bool {
        self.items.iter().any(|it| it.status.is_active())
    }
}

/// 从 ACP `session/update` (`sessionUpdate: "plan"`) 解析统一 `PlanSnapshot`。
pub fn parse_acp_plan_update(update: &Value) -> Option<PlanSnapshot> {
    if update.get("sessionUpdate").and_then(|v| v.as_str()) != Some("plan") {
        return None;
    }
    let arr = update.get("entries").and_then(|v| v.as_array())?;
    let items: Vec<PlanItem> = arr
        .iter()
        .enumerate()
        .filter_map(|(i, item)| {
            let content = item
                .get("content")
                .or_else(|| item.get("step"))
                .or_else(|| item.get("title"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_string();
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("acp-plan-{}", i + 1));
            let status = PlanItemStatus::parse(item.get("status").and_then(|v| v.as_str()));
            let priority = PlanItemPriority::parse(item.get("priority").and_then(|v| v.as_str()));
            let note = item
                .get("note")
                .or_else(|| item.get("explanation"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            Some(PlanItem {
                id,
                content,
                active_form: None,
                status,
                priority,
                note,
                blocked_by: Vec::new(),
            })
        })
        .collect();

    Some(PlanSnapshot {
        title: None,
        items,
        source: "acp_plan".to_string(),
    })
}

/// 从工具结果对象/文本中提取 `TaskCreate` 分配的真实 taskId (支持 JSON 字段与 `#N` / `Task N` 文案)。
fn extract_created_task_id(result: &Value) -> Option<String> {
    // 1. 直接字段 (自定义工具或 JSON 返回)
    for key in ["taskId", "task_id", "id"] {
        if let Some(v) = result.get(key) {
            if let Some(s) = v.as_str().filter(|s| !s.trim().is_empty()) {
                return Some(s.trim().to_string());
            }
            if let Some(n) = v.as_u64() {
                return Some(n.to_string());
            }
        }
    }

    // 2. 提取 content[].text 中的结构化 JSON 或 "Task #3 created..." 模式
    let mut texts = Vec::new();
    if let Some(s) = result.as_str() {
        texts.push(s.to_string());
    } else if let Some(arr) = result.get("content").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                texts.push(t.to_string());
            }
        }
    }
    let joined = texts.join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 尝试解析内嵌 JSON
    if trimmed.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            for key in ["taskId", "task_id", "id"] {
                if let Some(v) = parsed.get(key) {
                    if let Some(s) = v.as_str().filter(|s| !s.trim().is_empty()) {
                        return Some(s.trim().to_string());
                    }
                    if let Some(n) = v.as_u64() {
                        return Some(n.to_string());
                    }
                }
            }
        }
    }

    // 匹配 "Task #12" / "task #12" / "id: 12" / "ID: 12"
    let lower = trimmed.to_ascii_lowercase();
    for marker in ["task #", "task id:", "task_id:", "taskid:"] {
        if let Some(pos) = lower.find(marker) {
            let rest = trimmed[pos + marker.len()..].trim_start();
            let token: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}

fn parse_replace_list(arr: &[Value], id_prefix: &str) -> Vec<PlanItem> {
    arr.iter()
        .enumerate()
        .filter_map(|(i, item)| {
            let content = item
                .get("content")
                .or_else(|| item.get("step"))
                .or_else(|| item.get("subject"))
                .or_else(|| item.get("title"))
                .or_else(|| item.get("text"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_string();
            let id = item
                .get("id")
                .or_else(|| item.get("taskId"))
                .and_then(|v| {
                    v.as_str()
                        .map(|s| s.trim().to_string())
                        .or_else(|| v.as_u64().map(|n| n.to_string()))
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("{id_prefix}-{}", i + 1));
            let active_form = item
                .get("activeForm")
                .or_else(|| item.get("active_form"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let status = PlanItemStatus::parse(item.get("status").and_then(|v| v.as_str()));
            let priority = PlanItemPriority::parse(item.get("priority").and_then(|v| v.as_str()));
            let note = item
                .get("note")
                .or_else(|| item.get("explanation"))
                .or_else(|| item.get("description"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            Some(PlanItem {
                id,
                content,
                active_form,
                status,
                priority,
                note,
                blocked_by: Vec::new(),
            })
        })
        .collect()
}

fn parse_string_vec(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(|s| s.trim().to_string())
                        .or_else(|| item.as_u64().map(|n| n.to_string()))
                        .filter(|s| !s.is_empty())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 跨后端通用的有状态任务清单追踪器 (可挂载在每个会话后端或用于历史条目重放)。
#[derive(Debug, Default)]
pub struct PlanTracker {
    items: Vec<PlanItem>,
    source: String,
    title: Option<String>,
    next_seq: usize,
    /// `TaskCreate` 尚未收到 `tool_result` 前: `tool_call_id` → 暂定 `PlanItem.id`
    pending_creates: HashMap<String, String>,
}

impl PlanTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// 获取当前非空快照。
    pub fn snapshot(&self) -> Option<PlanSnapshot> {
        if self.source.is_empty() && self.items.is_empty() {
            return None;
        }
        Some(PlanSnapshot {
            title: self.title.clone(),
            items: self.items.clone(),
            source: self.source.clone(),
        })
    }

    /// 整表替换 (ACP `plan` / Codex `update_plan` / Claude `TodoWrite` / 未来自定义 Agent 直接复用)。
    pub fn replace(
        &mut self,
        items: Vec<PlanItem>,
        source: impl Into<String>,
        title: Option<String>,
    ) -> PlanSnapshot {
        self.items = items;
        self.source = source.into();
        self.title = title;
        self.pending_creates.clear();
        PlanSnapshot {
            title: self.title.clone(),
            items: self.items.clone(),
            source: self.source.clone(),
        }
    }

    /// 吸收一次工具调用启动 (`ToolStart`), 若命中已知任务清单工具则返回最新全量快照。
    pub fn ingest_tool_start(
        &mut self,
        tool_call_id: &str,
        tool_name: &str,
        args: &Value,
    ) -> Option<PlanSnapshot> {
        let normalized = tool_name.trim().to_ascii_lowercase();
        match normalized.as_str() {
            // 1. 整表替换型: Claude `TodoWrite`, OpenCode `todowrite`, Pi 扩展 `todo_write` / `write_todos`
            "todowrite" | "todo_write" | "write_todos" | "set_todos" => {
                let arr = args
                    .get("todos")
                    .or_else(|| args.get("items"))
                    .or_else(|| args.get("tasks"))
                    .and_then(|v| v.as_array())?;
                let items = parse_replace_list(arr, "todo");
                let title = args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                Some(self.replace(items, "claude_todo", title))
            }
            // 2. 整表替换型: Codex `update_plan` / 通用 `set_plan` / `write_plan`
            "update_plan" | "set_plan" | "write_plan" | "plan_write" => {
                let arr = args
                    .get("plan")
                    .or_else(|| args.get("entries"))
                    .or_else(|| args.get("steps"))
                    .or_else(|| args.get("items"))
                    .and_then(|v| v.as_array())?;
                let items = parse_replace_list(arr, "plan");
                let title = args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                Some(self.replace(items, "tool_plan", title))
            }
            // 3. 增量新增型: Claude 现代 `TaskCreate` / 通用 `task_create` / `create_task`
            "taskcreate" | "task_create" | "create_task" => {
                let subject = args
                    .get("subject")
                    .or_else(|| args.get("content"))
                    .or_else(|| args.get("title"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())?
                    .to_string();
                let active_form = args
                    .get("activeForm")
                    .or_else(|| args.get("active_form"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let note = args
                    .get("description")
                    .or_else(|| args.get("note"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let priority =
                    PlanItemPriority::parse(args.get("priority").and_then(|v| v.as_str()));

                // 若之前是从 TodoWrite 切过来的, 切到增量任务源时重置旧列表
                if !self.source.is_empty() && self.source != "claude_task" {
                    self.items.clear();
                    self.next_seq = 0;
                    self.pending_creates.clear();
                }
                self.source = "claude_task".to_string();
                self.next_seq += 1;
                let id = args
                    .get("taskId")
                    .or_else(|| args.get("id"))
                    .and_then(|v| {
                        v.as_str()
                            .map(|s| s.trim().to_string())
                            .or_else(|| v.as_u64().map(|n| n.to_string()))
                    })
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| self.next_seq.to_string());

                self.items.push(PlanItem {
                    id: id.clone(),
                    content: subject,
                    active_form,
                    status: PlanItemStatus::Pending,
                    priority,
                    note,
                    blocked_by: parse_string_vec(args.get("blockedBy")),
                });
                if !tool_call_id.is_empty() {
                    self.pending_creates.insert(tool_call_id.to_string(), id);
                }
                self.snapshot()
            }
            // 4. 增量更新型: Claude 现代 `TaskUpdate` / 通用 `task_update` / `update_task`
            "taskupdate" | "task_update" | "update_task" => {
                let task_id = args
                    .get("taskId")
                    .or_else(|| args.get("task_id"))
                    .or_else(|| args.get("id"))
                    .and_then(|v| {
                        v.as_str()
                            .map(|s| s.trim().to_string())
                            .or_else(|| v.as_u64().map(|n| n.to_string()))
                    })
                    .filter(|s| !s.is_empty())?;

                let raw_status = args.get("status").and_then(|v| v.as_str());
                if raw_status.map(|s| s.eq_ignore_ascii_case("deleted")) == Some(true) {
                    let prev_len = self.items.len();
                    self.items.retain(|it| it.id != task_id);
                    if self.items.len() != prev_len {
                        return self.snapshot();
                    }
                    return None;
                }

                if let Some(item) = self.items.iter_mut().find(|it| it.id == task_id) {
                    if let Some(st) = raw_status {
                        item.status = PlanItemStatus::parse(Some(st));
                    }
                    if let Some(subj) = args
                        .get("subject")
                        .or_else(|| args.get("content"))
                        .or_else(|| args.get("title"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        item.content = subj.to_string();
                    }
                    if let Some(af) = args
                        .get("activeForm")
                        .or_else(|| args.get("active_form"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        item.active_form = Some(af.to_string());
                    }
                    if let Some(desc) = args
                        .get("description")
                        .or_else(|| args.get("note"))
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        item.note = Some(desc.to_string());
                    }
                    for dep in parse_string_vec(args.get("addBlockedBy")) {
                        if !item.blocked_by.contains(&dep) {
                            item.blocked_by.push(dep);
                        }
                    }
                    return self.snapshot();
                }

                // 若在未见到 TaskCreate 的情况下收到 TaskUpdate (例如跨会话接续), 补建条目以防丢失
                let content = args
                    .get("subject")
                    .or_else(|| args.get("content"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())?;
                self.source = "claude_task".to_string();
                self.items.push(PlanItem {
                    id: task_id,
                    content,
                    active_form: args
                        .get("activeForm")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string()),
                    status: PlanItemStatus::parse(raw_status),
                    priority: PlanItemPriority::parse(
                        args.get("priority").and_then(|v| v.as_str()),
                    ),
                    note: args
                        .get("description")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string()),
                    blocked_by: parse_string_vec(args.get("addBlockedBy")),
                });
                self.snapshot()
            }
            _ => None,
        }
    }

    /// 吸收工具结束结果 (`ToolEnd`): 对齐 `TaskCreate` 返回的真实 taskId。
    pub fn ingest_tool_end(&mut self, tool_call_id: &str, result: &Value) -> Option<PlanSnapshot> {
        let provisional_id = self.pending_creates.remove(tool_call_id)?;
        let real_id = extract_created_task_id(result)?;
        if real_id == provisional_id {
            return None;
        }
        if let Some(item) = self.items.iter_mut().find(|it| it.id == provisional_id) {
            item.id = real_id;
            return self.snapshot();
        }
        None
    }
}

/// 从标准历史条目数组 (`start_session.entries`) 重放推导最后一份任务清单。
/// 遵循决策: 仅在仍存在未完成项时返回 `Some`, 全部已完成的历史会话返回 `None` 不自动弹出。
pub fn derive_active_plan_from_entries(entries: &[Value]) -> Option<PlanSnapshot> {
    let plan = derive_plan_from_entries(entries)?;
    if plan.has_incomplete() {
        Some(plan)
    } else {
        None
    }
}

/// 从标准历史条目数组推导最后一份完整任务清单 (含已完成项, 供测试与内部复用)。
pub fn derive_plan_from_entries(entries: &[Value]) -> Option<PlanSnapshot> {
    let mut tracker = PlanTracker::new();
    for entry in entries {
        if entry.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        let Some(msg) = entry.get("message") else {
            continue;
        };
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        match role {
            "assistant" => {
                if let Some(blocks) = msg.get("content").and_then(|v| v.as_array()) {
                    for b in blocks {
                        if b.get("type").and_then(|v| v.as_str()) == Some("toolCall") {
                            let id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let args = b.get("arguments").unwrap_or(&Value::Null);
                            tracker.ingest_tool_start(id, name, args);
                        }
                    }
                }
            }
            "toolResult" => {
                let id = msg.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("");
                if !id.is_empty() {
                    tracker.ingest_tool_end(id, msg);
                }
            }
            _ => {}
        }
    }
    tracker.snapshot().filter(|p| !p.items.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_acp_plan_update_entries() {
        let plan = parse_acp_plan_update(&json!({
            "sessionUpdate": "plan",
            "entries": [
                { "content": "Analyze codebase", "priority": "high", "status": "completed" },
                { "content": "Implement unified protocol", "priority": "medium", "status": "in_progress" },
                { "content": "Write tests", "priority": "low", "status": "pending" }
            ]
        }))
        .expect("should parse ACP plan");

        assert_eq!(plan.source, "acp_plan");
        assert_eq!(plan.items.len(), 3);
        assert_eq!(plan.items[0].status, PlanItemStatus::Completed);
        assert_eq!(plan.items[0].priority, Some(PlanItemPriority::High));
        assert_eq!(plan.items[1].status, PlanItemStatus::InProgress);
        assert_eq!(plan.items[2].status, PlanItemStatus::Pending);
        assert!(plan.has_incomplete());
    }

    #[test]
    fn tracks_claude_todo_write_and_codex_update_plan() {
        let mut tracker = PlanTracker::new();
        let snap1 = tracker
            .ingest_tool_start(
                "tc1",
                "TodoWrite",
                &json!({
                    "todos": [
                        { "content": "Read files", "status": "completed", "activeForm": "Reading files" },
                        { "content": "Edit backend", "status": "in_progress", "activeForm": "Editing backend" }
                    ]
                }),
            )
            .expect("TodoWrite should emit plan");
        assert_eq!(snap1.source, "claude_todo");
        assert_eq!(snap1.items.len(), 2);
        assert_eq!(snap1.items[1].active_form.as_deref(), Some("Editing backend"));

        let snap2 = tracker
            .ingest_tool_start(
                "tc2",
                "update_plan",
                &json!({
                    "plan": [
                        { "step": "Check schema", "status": "done", "explanation": "verified" },
                        { "step": "Run cargo test", "status": "pending" }
                    ]
                }),
            )
            .expect("update_plan should emit plan");
        assert_eq!(snap2.source, "tool_plan");
        assert_eq!(snap2.items[0].status, PlanItemStatus::Completed);
        assert_eq!(snap2.items[0].note.as_deref(), Some("verified"));
    }

    #[test]
    fn tracks_claude_task_create_update_delete_and_real_id_alignment() {
        let mut tracker = PlanTracker::new();
        let s1 = tracker
            .ingest_tool_start(
                "call_1",
                "TaskCreate",
                &json!({
                    "subject": "Implement auth",
                    "description": "Add JWT middleware",
                    "activeForm": "Implementing auth"
                }),
            )
            .unwrap();
        assert_eq!(s1.items.len(), 1);
        assert_eq!(s1.items[0].id, "1");

        // 模拟 tool_result 返回服务端分配的真实 ID #42
        let s2 = tracker
            .ingest_tool_end(
                "call_1",
                &json!({ "content": [{ "type": "text", "text": "Task #42 created successfully." }] }),
            )
            .unwrap();
        assert_eq!(s2.items[0].id, "42");

        // 使用真实 ID 更新状态与依赖
        let s3 = tracker
            .ingest_tool_start(
                "call_2",
                "TaskUpdate",
                &json!({
                    "taskId": "42",
                    "status": "in_progress",
                    "addBlockedBy": ["41"]
                }),
            )
            .unwrap();
        assert_eq!(s3.items[0].status, PlanItemStatus::InProgress);
        assert_eq!(s3.items[0].blocked_by, vec!["41"]);

        // deleted 移除条目
        let s4 = tracker
            .ingest_tool_start(
                "call_3",
                "TaskUpdate",
                &json!({ "taskId": "42", "status": "deleted" }),
            )
            .unwrap();
        assert!(s4.items.is_empty());
    }

    #[test]
    fn derives_active_plan_from_history_only_when_incomplete() {
        let unfinished = vec![json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "toolCall",
                    "id": "t1",
                    "name": "TodoWrite",
                    "arguments": {
                        "todos": [
                            { "content": "Step 1", "status": "completed", "activeForm": "Step 1" },
                            { "content": "Step 2", "status": "pending", "activeForm": "Step 2" }
                        ]
                    }
                }]
            }
        })];
        assert!(derive_active_plan_from_entries(&unfinished).is_some());

        let finished = vec![json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "toolCall",
                    "id": "t2",
                    "name": "TodoWrite",
                    "arguments": {
                        "todos": [
                            { "content": "Step 1", "status": "completed", "activeForm": "Step 1" }
                        ]
                    }
                }]
            }
        })];
        assert!(derive_plan_from_entries(&finished).is_some());
        assert!(derive_active_plan_from_entries(&finished).is_none());
    }
}
