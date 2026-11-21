//! Claude Code CLI 双向 `stream-json` 后端驱动。
//!
//! 通信协议:
//! - 启动: `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-prompts host --permission-mode <mode>`
//! - 输入: NDJSON (`user` 消息 / `control_request` / `control_response`)
//! - 输出: 经 `translate::ClaudeStreamTranslator` 翻译为 `UnifiedEvent` 发往 `agent_event`

pub mod history;
pub mod translate;

use crate::backends::process::{build_cli_command, kill_process_tree, strip_newline};
use crate::backends::{AgentKind, MessageUsage, UnifiedEvent};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

/// 允许的 Claude Code 权限模式集合 (对齐 `claude --help`)
pub const CLAUDE_PERMISSION_MODES: &[&str] = &[
    "auto",
    "manual",
    "acceptEdits",
    "plan",
    "dontAsk",
    "bypassPermissions",
];

/// Claude Code 支持的默认思考深度档位 (对齐 `claude --effort` 与 `initialize.models[].supportedEffortLevels`)
pub const CLAUDE_EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClaudeModelEntry {
    id: String,
    name: String,
    resolved_model: Option<String>,
    supports_effort: bool,
    supported_effort_levels: Vec<String>,
}

fn default_claude_models() -> Vec<ClaudeModelEntry> {
    let default_levels: Vec<String> = CLAUDE_EFFORT_LEVELS.iter().map(|s| (*s).to_string()).collect();
    vec![
        ClaudeModelEntry {
            id: "default".into(),
            name: "Default (推荐)".into(),
            resolved_model: None,
            supports_effort: true,
            supported_effort_levels: default_levels.clone(),
        },
        ClaudeModelEntry {
            id: "opus".into(),
            name: "opus".into(),
            resolved_model: None,
            supports_effort: true,
            supported_effort_levels: default_levels.clone(),
        },
        ClaudeModelEntry {
            id: "sonnet".into(),
            name: "sonnet".into(),
            resolved_model: None,
            supports_effort: true,
            supported_effort_levels: default_levels.clone(),
        },
        ClaudeModelEntry {
            id: "haiku".into(),
            name: "haiku".into(),
            resolved_model: None,
            supports_effort: true,
            supported_effort_levels: default_levels,
        },
    ]
}

fn extract_control_response_body(frame: &Value) -> Result<&Value, String> {
    let resp = frame.get("response").unwrap_or(frame);
    if resp.get("subtype").and_then(|v| v.as_str()) == Some("error") {
        let msg = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Claude 控制请求失败");
        return Err(msg.to_string());
    }
    Ok(resp.get("response").unwrap_or(&Value::Null))
}

fn parse_initialize_models(body: &Value) -> Vec<ClaudeModelEntry> {
    let Some(arr) = body.get("models").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(id) = item.get("value").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
            continue;
        };
        let name = item
            .get("displayName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string();
        let resolved_model = item
            .get("resolvedModel")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let supported_effort_levels: Vec<String> = item
            .get("supportedEffortLevels")
            .and_then(|v| v.as_array())
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let supports_effort = item
            .get("supportsEffort")
            .and_then(|v| v.as_bool())
            .unwrap_or(!supported_effort_levels.is_empty());
        out.push(ClaudeModelEntry {
            id: id.to_string(),
            name,
            resolved_model,
            supports_effort,
            supported_effort_levels,
        });
    }
    out
}

fn find_model_entry<'a>(
    catalog: &'a [ClaudeModelEntry],
    model_id: &str,
) -> Option<&'a ClaudeModelEntry> {
    catalog
        .iter()
        .find(|m| m.id == model_id)
        .or_else(|| {
            catalog
                .iter()
                .find(|m| m.resolved_model.as_deref() == Some(model_id))
        })
}

fn effort_levels_for_model(catalog: &[ClaudeModelEntry], model_id: Option<&str>) -> Vec<String> {
    let entry = model_id
        .and_then(|id| find_model_entry(catalog, id))
        .or_else(|| catalog.iter().find(|m| m.id == "default"));
    if let Some(m) = entry {
        if !m.supported_effort_levels.is_empty() {
            return m.supported_effort_levels.clone();
        }
        if !m.supports_effort {
            return vec!["off".to_string()];
        }
    }
    CLAUDE_EFFORT_LEVELS.iter().map(|s| (*s).to_string()).collect()
}

/// 会话级实时统计容器 (历史快照初始化 + 流式增量更新 → `get_session_stats` 权威数据源)。
#[derive(Debug, Clone, Default)]
struct ClaudeLiveStats {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cost_usd: f64,
    user_messages: u64,
    assistant_messages: u64,
    last_context_tokens: Option<u64>,
    last_model: Option<String>,
    context_window: Option<u64>,
}

impl ClaudeLiveStats {
    fn from_snapshot(snap: history::ClaudeSessionStatsSnapshot) -> Self {
        Self {
            input_tokens: snap.input_tokens,
            output_tokens: snap.output_tokens,
            cache_read_tokens: snap.cache_read_tokens,
            cache_write_tokens: snap.cache_write_tokens,
            cost_usd: snap.cost_usd,
            user_messages: snap.user_messages,
            assistant_messages: snap.assistant_messages,
            last_context_tokens: snap.last_context_tokens,
            last_model: snap.last_model,
            context_window: snap.context_window,
        }
    }

    /// 吸收单条 `AssistantEnd` 的 token 用量 (忽略 `result` 发出的仅含 `cost` 的 0-token 尾帧)。
    fn apply_assistant_usage(&mut self, u: &MessageUsage) {
        if u.input == 0 && u.output == 0 && u.cache_read == 0 && u.cache_write == 0 {
            return;
        }
        self.input_tokens += u.input;
        self.output_tokens += u.output;
        self.cache_read_tokens += u.cache_read;
        self.cache_write_tokens += u.cache_write;
        self.assistant_messages += 1;
        let ctx = u.input + u.cache_read + u.cache_write;
        if ctx > 0 {
            self.last_context_tokens = Some(ctx);
        }
    }

    /// 吸收 Claude `result` 帧中的权威 `contextWindow` 与单轮增量费用。
    fn apply_result_frame(&mut self, frame: &Value, current_model: Option<&str>) {
        // 1. 提取权威 contextWindow (优先匹配当前模型, 否则取 modelUsage 中最大非零值)
        if let Some(mu) = frame.get("modelUsage").and_then(|v| v.as_object()) {
            let preferred = current_model.or(self.last_model.as_deref());
            let mut matched_cw = None;
            let mut max_cw = 0u64;
            for (model_key, entry) in mu {
                if let Some(cw) = entry.get("contextWindow").and_then(|v| v.as_u64()) {
                    if cw > 0 {
                        if preferred == Some(model_key.as_str()) {
                            matched_cw = Some(cw);
                        }
                        if cw > max_cw {
                            max_cw = cw;
                        }
                    }
                }
            }
            if let Some(cw) = matched_cw.or((max_cw > 0).then_some(max_cw)) {
                self.context_window = Some(cw);
            }
        }

        // 2. 累加本轮增量费用: 优先用 model_usage_since_last_result (精准增量), 回退 total_cost_usd
        if let Some(since) = frame
            .get("model_usage_since_last_result")
            .and_then(|v| v.as_object())
        {
            let delta: f64 = since
                .values()
                .filter_map(|e| e.get("costUSD").and_then(|v| v.as_f64()))
                .filter(|c| *c > 0.0)
                .sum();
            if delta > 0.0 {
                self.cost_usd += delta;
                return;
            }
        }
        if let Some(c) = frame.get("total_cost_usd").and_then(|v| v.as_f64()) {
            if c > 0.0 {
                self.cost_usd += c;
            }
        }
    }

    /// 构造与前端 `loadSessionStats` 契约完全对齐的 JSON。
    fn to_stats_json(&self, fallback_model: Option<&str>) -> Value {
        let model = self.last_model.as_deref().or(fallback_model);
        let total = self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens;

        let mut obj = serde_json::Map::new();
        if let Some(used) = self.last_context_tokens {
            let window = self
                .context_window
                .unwrap_or_else(|| history::infer_claude_context_window(model, Some(used)));
            let percent = if window > 0 {
                Some(((used as f64) / (window as f64) * 100.0).clamp(0.0, 100.0))
            } else {
                None
            };
            obj.insert(
                "contextUsage".into(),
                json!({
                    "tokens": used,
                    "contextWindow": window,
                    "percent": percent,
                }),
            );
        }
        if total > 0 || self.user_messages > 0 || self.assistant_messages > 0 {
            obj.insert(
                "tokens".into(),
                json!({
                    "input": self.input_tokens,
                    "output": self.output_tokens,
                    "cacheRead": self.cache_read_tokens,
                    "cacheWrite": self.cache_write_tokens,
                    "total": total,
                }),
            );
            obj.insert("cost".into(), json!(self.cost_usd));
            obj.insert("userMessages".into(), json!(self.user_messages));
            obj.insert("assistantMessages".into(), json!(self.assistant_messages));
            obj.insert(
                "totalMessages".into(),
                json!(self.user_messages + self.assistant_messages),
            );
        }
        Value::Object(obj)
    }
}

pub struct ClaudeBackend {
    child: Child,
    stdin: ChildStdin,
    pending: PendingRequests,
    id_counter: Arc<AtomicU64>,
    /// 待回复的工具审批请求原始 input 缓存 (回写 allow 时可附带 updatedInput)
    pending_permissions: Arc<Mutex<HashMap<String, Value>>>,
    remote_session_id: Arc<Mutex<Option<String>>>,
    current_model: Arc<Mutex<Option<String>>>,
    permission_mode: Arc<Mutex<String>>,
    models_catalog: Vec<ClaudeModelEntry>,
    effort: String,
    session_path: Arc<Mutex<Option<String>>>,
    stats: Arc<Mutex<ClaudeLiveStats>>,
}

impl ClaudeBackend {
    pub async fn spawn(
        app: AppHandle,
        session_id: String,
        cwd: String,
        model: Option<String>,
        permission_mode: Option<String>,
        resume_session_id: Option<String>,
        session_path: Option<String>,
        cli_override: Option<String>,
    ) -> Result<Self, String> {
        let mode = permission_mode
            .filter(|m| CLAUDE_PERMISSION_MODES.contains(&m.as_str()))
            .unwrap_or_else(|| "auto".to_string());
        let program = cli_override
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("claude");

        let mut cmd = build_cli_command(
            program,
            &[
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--permission-prompts",
                "host",
                "--permission-mode",
                &mode,
            ],
        );
        if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("--model").arg(m);
        }
        if let Some(rid) = resume_session_id.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("--resume").arg(rid);
        }
        cmd.current_dir(&cwd);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            format!("启动 claude 子进程失败: {e}。确认本机已安装 Claude Code CLI 且在 PATH 中")
        })?;

        let stdin = child.stdin.take().ok_or("无法获取 claude stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取 claude stdout")?;
        let stderr = child.stderr.take();

        let initial_stats = session_path
            .as_deref()
            .map(|p| ClaudeLiveStats::from_snapshot(history::read_claude_session_stats(Path::new(p))))
            .unwrap_or_default();

        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();
        let pending_permissions: Arc<Mutex<HashMap<String, Value>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let perms_for_reader = pending_permissions.clone();
        let remote_session_id = Arc::new(Mutex::new(resume_session_id));
        let rsid_for_reader = remote_session_id.clone();
        let current_model = Arc::new(Mutex::new(model));
        let model_for_reader = current_model.clone();
        let permission_mode_state = Arc::new(Mutex::new(mode));
        let pmode_for_reader = permission_mode_state.clone();
        let session_path_state = Arc::new(Mutex::new(session_path));
        let spath_for_reader = session_path_state.clone();
        let stats = Arc::new(Mutex::new(initial_stats));
        let stats_for_reader = stats.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::with_capacity(8192);
            let mut translator = translate::ClaudeStreamTranslator::new();

            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => {
                        let ev = UnifiedEvent::ProcessExit {
                            agent_kind: AgentKind::Claude,
                            message: "Claude Code 进程已退出".into(),
                        };
                        let _ = app.emit(
                            "agent_event",
                            json!({ "sessionId": session_id, "event": ev }),
                        );
                        break;
                    }
                    Ok(_) => {
                        let line = strip_newline(&buf);
                        if line.is_empty() {
                            continue;
                        }
                        let Ok(frame) = serde_json::from_slice::<Value>(line) else {
                            continue;
                        };

                        let frame_type = frame.get("type").and_then(|v| v.as_str());

                        // host → CLI 发出的 control_request 响应直接唤醒 pending channel
                        if frame_type == Some("control_response") {
                            let req_id = frame
                                .get("response")
                                .and_then(|r| r.get("request_id"))
                                .or_else(|| frame.get("request_id"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            if let Some(id) = req_id {
                                let mut guard = pending_for_reader.lock().await;
                                if let Some(tx) = guard.remove(&id) {
                                    let _ = tx.send(frame);
                                    continue;
                                }
                            }
                        }

                        if frame_type == Some("result") {
                            let cur_m = model_for_reader.lock().await.clone();
                            stats_for_reader
                                .lock()
                                .await
                                .apply_result_frame(&frame, cur_m.as_deref());
                        }

                        let events = translator.translate(&frame);
                        for mut ev in events {
                            // 同步缓存会话元数据、实时统计与待审批请求输入
                            match &mut ev {
                                UnifiedEvent::SessionMeta {
                                    session_path: sp_out,
                                    remote_session_id: rsid,
                                    model,
                                    permission_mode,
                                } => {
                                    if let Some(id) = rsid {
                                        *rsid_for_reader.lock().await = Some(id.clone());
                                        // 若为新建会话且尚未记录落盘路径, 顺带尝试定位文件
                                        let mut sp_guard = spath_for_reader.lock().await;
                                        if sp_guard.is_none() {
                                            if let Some(found) = history::locate_claude_session_file(id) {
                                                let s = found.to_string_lossy().to_string();
                                                *sp_guard = Some(s.clone());
                                                *sp_out = Some(s);
                                            }
                                        }
                                    }
                                    if let Some(m) = model {
                                        *model_for_reader.lock().await = Some(m.clone());
                                        stats_for_reader.lock().await.last_model = Some(m.clone());
                                    }
                                    if let Some(pm) = permission_mode {
                                        *pmode_for_reader.lock().await = pm.clone();
                                    }
                                }
                                UnifiedEvent::AssistantEnd { usage: Some(u), .. } => {
                                    stats_for_reader.lock().await.apply_assistant_usage(u);
                                }
                                UnifiedEvent::TurnSettled => {
                                    // 本轮落盘完成后补一次会话路径定位, 确保前端 turn_settled 自动刷新侧栏
                                    let mut sp_guard = spath_for_reader.lock().await;
                                    if sp_guard.is_none() {
                                        if let Some(rsid) = rsid_for_reader.lock().await.clone() {
                                            if let Some(found) = history::locate_claude_session_file(&rsid) {
                                                let s = found.to_string_lossy().to_string();
                                                *sp_guard = Some(s.clone());
                                                drop(sp_guard);
                                                let _ = app.emit(
                                                    "agent_event",
                                                    json!({
                                                        "sessionId": session_id,
                                                        "event": UnifiedEvent::SessionMeta {
                                                            session_path: Some(s),
                                                            remote_session_id: None,
                                                            model: None,
                                                            permission_mode: None,
                                                        }
                                                    }),
                                                );
                                            }
                                        }
                                    }
                                }
                                UnifiedEvent::PermissionRequest { request } => {
                                    perms_for_reader
                                        .lock()
                                        .await
                                        .insert(request.id.clone(), request.input.clone());
                                }
                                _ => {}
                            }
                            let _ = app.emit(
                                "agent_event",
                                json!({ "sessionId": session_id, "event": ev }),
                            );
                        }
                    }
                    Err(e) => {
                        eprintln!("[claude_backend] 读 stdout 出错: {e}");
                        break;
                    }
                }
            }
        });

        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::with_capacity(1024);
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let s = String::from_utf8_lossy(&buf);
                            eprintln!("[claude stderr] {}", s.trim_end());
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let mut backend = Self {
            child,
            stdin,
            pending,
            id_counter: Arc::new(AtomicU64::new(0)),
            pending_permissions,
            remote_session_id,
            current_model,
            permission_mode: permission_mode_state,
            models_catalog: default_claude_models(),
            effort: "medium".to_string(),
            session_path: session_path_state,
            stats,
        };
        backend.bootstrap_session_info().await;
        Ok(backend)
    }

    /// 进程启动后 (锁外) 做一次 best-effort 握手:
    /// 1. `initialize` 拉取真实模型目录与每个模型支持的 effort 档位
    /// 2. `get_settings` 拉取生效的 `effortLevel` 与默认 `model`, 避免 UI 在首条消息前显示假默认值
    async fn bootstrap_session_info(&mut self) {
        if let Ok(frame) = self
            .send_control_request(json!({ "subtype": "initialize" }), 5)
            .await
        {
            if let Ok(body) = extract_control_response_body(&frame) {
                let parsed = parse_initialize_models(body);
                if !parsed.is_empty() {
                    self.models_catalog = parsed;
                }
                if let Some(pm) = body.get("current_permission_mode").and_then(|v| v.as_str()) {
                    if CLAUDE_PERMISSION_MODES.contains(&pm) {
                        *self.permission_mode.lock().await = pm.to_string();
                    }
                }
            }
        }

        if let Ok(frame) = self
            .send_control_request(json!({ "subtype": "get_settings" }), 4)
            .await
        {
            if let Ok(body) = extract_control_response_body(&frame) {
                if let Some(effective) = body.get("effective") {
                    if let Some(eff) = effective
                        .get("effortLevel")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        self.effort = eff.to_string();
                    }
                    let mut cur_model = self.current_model.lock().await;
                    if cur_model.is_none() {
                        if let Some(m) = effective
                            .get("model")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                        {
                            *cur_model = Some(m.to_string());
                        }
                    }
                }
            }
        }
    }

    async fn current_effort_levels(&self) -> Vec<String> {
        let cur = self.current_model.lock().await.clone();
        effort_levels_for_model(&self.models_catalog, cur.as_deref())
    }

    fn display_name_for_model(&self, model_id: &str) -> String {
        find_model_entry(&self.models_catalog, model_id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| model_id.to_string())
    }

    async fn write_frame(&mut self, frame: &Value) -> Result<(), String> {
        let line = serde_json::to_string(frame).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("写 claude stdin 失败: {e}"))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("写换行失败: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("flush claude stdin 失败: {e}"))?;
        Ok(())
    }

    async fn send_control_request(
        &mut self,
        request: Value,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        let req_id = format!("cc-req-{}", self.id_counter.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(req_id.clone(), tx);

        let frame = json!({
            "type": "control_request",
            "request_id": req_id,
            "request": request,
        });
        self.write_frame(&frame).await?;

        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&req_id);
                Err("Claude 控制响应通道关闭".into())
            }
            Err(_) => {
                self.pending.lock().await.remove(&req_id);
                Err(format!("等待 Claude 控制响应超时 ({timeout_secs}s)"))
            }
        }
    }

    pub async fn send_prompt(
        &mut self,
        message: String,
        images: Option<Vec<Value>>,
    ) -> Result<Value, String> {
        let content = match images {
            Some(imgs) if !imgs.is_empty() => {
                let mut blocks: Vec<Value> = Vec::with_capacity(imgs.len() + 1);
                for img in imgs {
                    if let (Some(data), Some(mime)) = (
                        img.get("data").and_then(|v| v.as_str()),
                        img.get("mimeType").and_then(|v| v.as_str()),
                    ) {
                        blocks.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime,
                                "data": data,
                            }
                        }));
                    }
                }
                blocks.push(json!({ "type": "text", "text": message }));
                Value::Array(blocks)
            }
            _ => Value::String(message),
        };

        let frame = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": content,
            }
        });
        self.write_frame(&frame).await?;
        self.stats.lock().await.user_messages += 1;
        Ok(json!({ "disposition": "started" }))
    }

    pub async fn abort(&mut self) -> Result<(), String> {
        match self
            .send_control_request(json!({ "subtype": "interrupt" }), 8)
            .await
        {
            Ok(_) => Ok(()),
            Err(e) if e.starts_with("等待 Claude 控制响应超时") => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub async fn set_model(&mut self, _provider: String, model_id: String) -> Result<Value, String> {
        let resp = self
            .send_control_request(
                json!({ "subtype": "set_model", "model": model_id }),
                10,
            )
            .await?;
        extract_control_response_body(&resp)?;
        *self.current_model.lock().await = Some(model_id.clone());
        {
            let mut st = self.stats.lock().await;
            let resolved = find_model_entry(&self.models_catalog, &model_id)
                .and_then(|m| m.resolved_model.clone())
                .unwrap_or_else(|| model_id.clone());
            st.last_model = Some(resolved);
            st.context_window = None;
        }

        // 若目标模型支持的 effort 档位不包含当前值, 自动对齐到兼容档位 (如 xhigh -> high)
        let supported = self.current_effort_levels().await;
        if !supported.is_empty() && !supported.iter().any(|lv| lv == &self.effort) {
            if supported.len() == 1 && supported[0] == "off" {
                self.effort = "off".to_string();
            } else {
                let fallback = if supported.iter().any(|lv| lv == "high") {
                    "high".to_string()
                } else {
                    supported
                        .last()
                        .cloned()
                        .unwrap_or_else(|| "medium".to_string())
                };
                if self
                    .send_control_request(
                        json!({
                            "subtype": "apply_flag_settings",
                            "settings": { "effortLevel": fallback },
                        }),
                        8,
                    )
                    .await
                    .and_then(|r| extract_control_response_body(&r).map(|_| ()))
                    .is_ok()
                {
                    self.effort = fallback;
                }
            }
        }

        let name = self.display_name_for_model(&model_id);
        Ok(json!({
            "id": model_id,
            "name": name,
            "provider": "anthropic"
        }))
    }

    pub async fn set_permission_mode(&mut self, mode: String) -> Result<Value, String> {
        if !CLAUDE_PERMISSION_MODES.contains(&mode.as_str()) {
            return Err(format!("不支持的 Claude 权限模式: {mode}"));
        }
        let resp = self
            .send_control_request(
                json!({ "subtype": "set_permission_mode", "mode": mode }),
                10,
            )
            .await?;
        extract_control_response_body(&resp)?;
        *self.permission_mode.lock().await = mode.clone();
        Ok(json!({ "permissionMode": mode }))
    }

    pub async fn respond_permission(
        &mut self,
        request_id: String,
        allow: bool,
        reason: Option<String>,
        _option_id: Option<String>,
    ) -> Result<(), String> {
        let orig_input = self
            .pending_permissions
            .lock()
            .await
            .remove(&request_id)
            .unwrap_or_else(|| json!({}));

        let payload = if allow {
            json!({
                "behavior": "allow",
                "updatedInput": orig_input,
            })
        } else {
            json!({
                "behavior": "deny",
                "message": reason.unwrap_or_else(|| "用户拒绝执行该工具".to_string()),
            })
        };

        let frame = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": payload,
            }
        });
        self.write_frame(&frame).await
    }

    pub async fn get_state(&mut self) -> Result<Value, String> {
        let model = self.current_model.lock().await.clone();
        let mode = self.permission_mode.lock().await.clone();
        let rsid = self.remote_session_id.lock().await.clone();
        let session_file = {
            let mut sp = self.session_path.lock().await;
            if sp.is_none() {
                if let Some(id) = rsid.as_deref() {
                    if let Some(found) = history::locate_claude_session_file(id) {
                        *sp = Some(found.to_string_lossy().to_string());
                    }
                }
            }
            sp.clone()
        };
        Ok(json!({
            "model": model.as_ref().map(|m| json!({
                "id": m,
                "name": self.display_name_for_model(m),
                "provider": "anthropic"
            })),
            "thinkingLevel": self.effort,
            "permissionMode": mode,
            "sessionFile": session_file,
            "remoteSessionId": rsid,
        }))
    }

    pub async fn get_available_models(&mut self) -> Result<Value, String> {
        let mut models: Vec<Value> = self
            .models_catalog
            .iter()
            .map(|m| {
                json!({
                    "id": m.id,
                    "name": m.name,
                    "provider": "anthropic"
                })
            })
            .collect();
        if let Some(cur) = self.current_model.lock().await.clone() {
            if find_model_entry(&self.models_catalog, &cur).is_none() {
                models.insert(
                    0,
                    json!({ "id": cur, "name": cur, "provider": "anthropic" }),
                );
            }
        }
        Ok(json!({ "models": models }))
    }

    pub async fn get_available_thinking_levels(&mut self) -> Result<Value, String> {
        let levels = self.current_effort_levels().await;
        Ok(json!({ "levels": levels, "current": self.effort }))
    }

    pub async fn set_thinking_level(&mut self, level: String) -> Result<Value, String> {
        let allowed = self.current_effort_levels().await;
        if allowed.len() == 1 && allowed[0] == "off" {
            return Err("当前 Claude 模型不支持调节思考深度".into());
        }
        if !allowed.iter().any(|lv| lv == &level) {
            return Err(format!(
                "当前模型不支持的思考等级: {level}（可选: {}）",
                allowed.join(", ")
            ));
        }
        let resp = self
            .send_control_request(
                json!({
                    "subtype": "apply_flag_settings",
                    "settings": { "effortLevel": level },
                }),
                8,
            )
            .await?;
        extract_control_response_body(&resp)?;
        self.effort = level.clone();
        Ok(json!({ "level": level }))
    }

    pub async fn cycle_thinking_level(&mut self) -> Result<Value, String> {
        let levels = self.current_effort_levels().await;
        if levels.len() <= 1 {
            return Ok(json!({ "level": self.effort }));
        }
        let next_idx = levels
            .iter()
            .position(|lv| lv == &self.effort)
            .map(|i| (i + 1) % levels.len())
            .unwrap_or(0);
        let next = levels[next_idx].clone();
        self.set_thinking_level(next).await
    }

    pub async fn get_entries(&mut self) -> Result<Value, String> {
        let path = self.session_path.lock().await.clone();
        let Some(p) = path else {
            return Ok(json!({ "entries": [] }));
        };
        let abs = history::ensure_within_claude_projects(Path::new(&p))?;
        let entries = history::read_claude_session_entries(&abs)?;
        Ok(json!({ "entries": entries }))
    }

    pub async fn get_session_stats(&mut self) -> Result<Value, String> {
        let cur_model = self.current_model.lock().await.clone();
        let resolved_model = cur_model.as_deref().map(|id| {
            find_model_entry(&self.models_catalog, id)
                .and_then(|m| m.resolved_model.as_deref())
                .unwrap_or(id)
        });
        let st = self.stats.lock().await;
        Ok(st.to_stats_json(resolved_model))
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        kill_process_tree(&mut self.child).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_stats_tracks_context_usage_and_ignores_cost_only_tail_frame() {
        let mut st = ClaudeLiveStats::default();
        st.user_messages = 1;
        st.apply_assistant_usage(&MessageUsage {
            input: 2,
            output: 112,
            cache_read: 0,
            cache_write: 38188,
            cost: None,
            cost_detail: None,
        });
        // 模拟 translate.rs 为 result 补发的 0-token 纯 cost 尾帧: 绝不能把 last_context_tokens 清零
        st.apply_assistant_usage(&MessageUsage {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            cost: Some(0.307752),
            cost_detail: None,
        });
        st.apply_result_frame(
            &json!({
                "type": "result",
                "total_cost_usd": 0.307752,
                "modelUsage": {
                    "claude-opus-5-5": { "contextWindow": 1000000, "costUSD": 0.307752 }
                },
                "model_usage_since_last_result": {
                    "claude-opus-5-5": { "contextWindow": 1000000, "costUSD": 0.307752 }
                }
            }),
            Some("claude-opus-5-5"),
        );

        let v = st.to_stats_json(Some("claude-opus-5-5"));
        assert_eq!(v["contextUsage"]["tokens"], 38190);
        assert_eq!(v["contextUsage"]["contextWindow"], 1000000);
        assert!((v["contextUsage"]["percent"].as_f64().unwrap() - 3.819).abs() < 1e-3);
        assert_eq!(v["tokens"]["input"], 2);
        assert_eq!(v["tokens"]["output"], 112);
        assert_eq!(v["tokens"]["cacheWrite"], 38188);
        assert_eq!(v["tokens"]["total"], 38302);
        assert_eq!(v["userMessages"], 1);
        assert_eq!(v["assistantMessages"], 1);
        assert!((v["cost"].as_f64().unwrap() - 0.307752).abs() < 1e-6);
    }

    #[test]
    fn parses_initialize_models_and_resolves_effort_levels() {
        let body = json!({
            "models": [
                {
                    "value": "default",
                    "resolvedModel": "claude-opus-5-5",
                    "displayName": "Default (recommended)",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
                },
                {
                    "value": "claude-opus-4-6",
                    "resolvedModel": "claude-opus-4-6",
                    "displayName": "Opus 4.6",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "medium", "high", "max"]
                },
                {
                    "value": "claude-haiku-4-5-20251001",
                    "resolvedModel": "claude-haiku-4-5-20251001",
                    "displayName": "Haiku 4.5",
                    "supportsThinkingOff": true
                }
            ]
        });

        let catalog = parse_initialize_models(&body);
        assert_eq!(catalog.len(), 3);
        assert_eq!(
            effort_levels_for_model(&catalog, Some("claude-opus-5-5")),
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(
            effort_levels_for_model(&catalog, Some("claude-opus-4-6")),
            vec!["low", "medium", "high", "max"]
        );
        assert_eq!(
            effort_levels_for_model(&catalog, Some("claude-haiku-4-5-20251001")),
            vec!["off"]
        );
        assert_eq!(
            effort_levels_for_model(&catalog, None),
            vec!["low", "medium", "high", "xhigh", "max"]
        );
    }

    #[test]
    fn control_response_body_surfaces_errors() {
        let ok = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "r1", "response": { "ok": true } }
        });
        assert_eq!(extract_control_response_body(&ok).unwrap()["ok"], true);

        let err = json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": "r2", "error": "Unsupported control request" }
        });
        assert!(extract_control_response_body(&err)
            .unwrap_err()
            .contains("Unsupported"));
    }
}
