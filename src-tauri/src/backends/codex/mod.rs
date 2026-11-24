//! Codex CLI (`codex app-server --stdio`) 后端驱动。
//!
//! 通信协议:
//! - 启动: `codex app-server --stdio` (JSON-RPC 2.0 over stdio, 经 `backends/process.rs` 统一抑窗 + 代理透传)
//! - 握手: `initialize` → `initialized` → `model/list` → `thread/start` 或 `thread/resume`
//! - 轮次: `turn/start` (非阻塞写完即返，后台收 `turn/started` / `item/*` / `turn/plan/updated` /
//!   `thread/tokenUsage/updated` / `turn/completed`)
//! - 交互: 双向支持 `turn/steer` (运行中插话)、`turn/interrupt` (中止)、`thread/name/set` (重命名)、
//!   工具权限审批 (`requestApproval`) 与结构化提问 (`item/tool/requestUserInput`)

pub mod history;
pub mod protocol;

use crate::backends::plan::{PlanSnapshot, PlanTracker};
use crate::backends::process::{build_cli_command, kill_process_tree, strip_newline};
use crate::backends::{AgentKind, NotifyLevel, UnifiedEvent, UserPromptResponse};
use protocol::{CodexApprovalKind, CodexModelEntry, CodexStreamTranslator, CodexTokenBreakdown};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

const CODEX_INIT_TIMEOUT_SECS: u64 = 15;
const CODEX_SESSION_TIMEOUT_SECS: u64 = 30;
const STDERR_TAIL_LIMIT: usize = 8;

type PendingRpc = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;
type StderrTail = Arc<Mutex<VecDeque<String>>>;

struct PendingCodexPermission {
    rpc_id: Value,
    kind: CodexApprovalKind,
}

/// Codex 会话实时遥测统计 (由 `thread/tokenUsage/updated` 维护)。
#[derive(Debug, Clone, Default)]
struct CodexSessionStats {
    total: CodexTokenBreakdown,
    last: CodexTokenBreakdown,
    context_window: Option<u64>,
    user_messages: u64,
    assistant_messages: u64,
}

impl CodexSessionStats {
    fn apply_usage_update(
        &mut self,
        total: CodexTokenBreakdown,
        last: CodexTokenBreakdown,
        window: Option<u64>,
    ) {
        self.total = total;
        self.last = last;
        if let Some(w) = window {
            if w > 0 {
                self.context_window = Some(w);
            }
        }
    }

    fn to_stats_json(&self) -> Value {
        let mut obj = serde_json::Map::new();

        let ctx_used = if self.last.total_tokens > 0 {
            Some(self.last.total_tokens)
        } else if self.last.input_tokens > 0 {
            Some(self.last.input_tokens)
        } else {
            None
        };
        if let Some(used) = ctx_used {
            let window = self.context_window.unwrap_or(0);
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

        let uncached_input = self
            .total
            .input_tokens
            .saturating_sub(self.total.cached_input_tokens)
            .saturating_sub(self.total.cache_write_input_tokens);
        let cache_read = self.total.cached_input_tokens;
        let cache_write = self.total.cache_write_input_tokens;
        let output = self.total.output_tokens;
        let total = uncached_input + cache_read + cache_write + output;

        if total > 0 || self.user_messages > 0 || self.assistant_messages > 0 {
            obj.insert(
                "tokens".into(),
                json!({
                    "input": uncached_input,
                    "output": output,
                    "cacheRead": cache_read,
                    "cacheWrite": cache_write,
                    "total": total,
                }),
            );
            obj.insert("cost".into(), json!(0.0));
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

pub struct CodexBackend {
    app: AppHandle,
    session_id: String,
    cwd: String,
    thread_id: String,
    session_path: Arc<Mutex<Option<String>>>,
    models_catalog: Vec<CodexModelEntry>,
    current_model: Arc<Mutex<Option<String>>>,
    current_effort: Arc<Mutex<String>>,
    permission_mode: Arc<Mutex<String>>,
    active_turn_id: Arc<Mutex<Option<String>>>,
    translator: Arc<Mutex<CodexStreamTranslator>>,
    stats: Arc<Mutex<CodexSessionStats>>,
    initial_entries: Vec<Value>,
    initial_plan: Option<PlanSnapshot>,
    migration_notice: Option<String>,
    fallback_history_thread_id: Option<String>,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingRpc,
    pending_permissions: Arc<Mutex<HashMap<String, PendingCodexPermission>>>,
    pending_prompts: Arc<Mutex<HashMap<String, Value>>>,
    stderr_tail: StderrTail,
    id_counter: Arc<AtomicU64>,
}

fn find_model<'a>(catalog: &'a [CodexModelEntry], model_id: &str) -> Option<&'a CodexModelEntry> {
    catalog.iter().find(|m| m.id == model_id)
}

fn effort_levels_for_model(catalog: &[CodexModelEntry], model_id: Option<&str>) -> Vec<String> {
    if let Some(entry) = model_id
        .and_then(|id| find_model(catalog, id))
        .or_else(|| catalog.iter().find(|m| m.is_default))
        .or_else(|| catalog.first())
    {
        if !entry.supported_efforts.is_empty() {
            return entry.supported_efforts.clone();
        }
    }
    protocol::CODEX_EFFORT_LEVELS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

impl CodexBackend {
    #[allow(clippy::too_many_arguments)]
    pub async fn spawn(
        app: AppHandle,
        session_id: String,
        cwd: String,
        model: Option<String>,
        permission_mode: Option<String>,
        resume_session_path: Option<String>,
        cli_override: Option<String>,
    ) -> Result<Self, String> {
        let program = cli_override
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("codex")
            .to_string();

        let initial_mode = permission_mode
            .filter(|m| protocol::CODEX_PERMISSION_MODES.contains(&m.as_str()))
            .unwrap_or_else(|| "auto".to_string());

        let mut cmd = build_cli_command(&program, &["app-server", "--stdio"]);
        cmd.current_dir(&cwd);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "启动 Codex CLI ({program}) 失败: {e}。可在设置 → Agent 运行时中检查或覆盖可执行文件路径"
            )
        })?;

        let stdin = Arc::new(Mutex::new(
            child
                .stdin
                .take()
                .ok_or_else(|| format!("无法获取 {program} stdin"))?,
        ));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("无法获取 {program} stdout"))?;
        let stderr = child.stderr.take();

        let pending: PendingRpc = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();
        let pending_permissions: Arc<Mutex<HashMap<String, PendingCodexPermission>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let perms_for_reader = pending_permissions.clone();
        let pending_prompts: Arc<Mutex<HashMap<String, Value>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let prompts_for_reader = pending_prompts.clone();
        let req_counter = Arc::new(AtomicU64::new(1));

        let session_path: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let session_path_for_reader = session_path.clone();
        let current_model: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(model.clone()));
        let current_effort: Arc<Mutex<String>> = Arc::new(Mutex::new("medium".to_string()));
        let permission_mode_arc: Arc<Mutex<String>> =
            Arc::new(Mutex::new(initial_mode.clone()));
        let active_turn_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let active_turn_for_reader = active_turn_id.clone();
        let translator = Arc::new(Mutex::new(CodexStreamTranslator::new()));
        let translator_for_reader = translator.clone();
        let stats = Arc::new(Mutex::new(CodexSessionStats::default()));
        let stats_for_reader = stats.clone();

        let app_for_reader = app.clone();
        let sid_for_reader = session_id.clone();
        let stdin_for_reader = stdin.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::with_capacity(8192);
            let mut tool_plan_tracker = PlanTracker::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => {
                        let ev = UnifiedEvent::ProcessExit {
                            agent_kind: AgentKind::Codex,
                            message: "Codex App Server 进程已退出".to_string(),
                        };
                        let _ = app_for_reader.emit(
                            "agent_event",
                            json!({ "sessionId": sid_for_reader, "event": ev }),
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

                        let method = frame.get("method").and_then(|v| v.as_str());
                        let rpc_id = frame.get("id");

                        match (method, rpc_id) {
                            // 1. Response 帧 → 唤醒等待中的 RPC oneshot
                            (None, Some(id_val)) => {
                                if let Some(num_id) = id_val.as_u64() {
                                    let mut guard = pending_for_reader.lock().await;
                                    if let Some(tx) = guard.remove(&num_id) {
                                        let _ = tx.send(frame);
                                    }
                                }
                            }
                            // 2. ServerRequest (有 method 且有 id) → 权限审批 / 结构化提问 / 不支持兜底
                            (Some(m), Some(id_val)) => {
                                let params = frame.get("params").cloned().unwrap_or(Value::Null);
                                if m == "item/tool/requestUserInput" {
                                    let key = format!(
                                        "cdx-prompt-{}",
                                        req_counter.fetch_add(1, Ordering::SeqCst)
                                    );
                                    if let Some(prompt_req) =
                                        protocol::translate_codex_user_input_request(
                                            key.clone(),
                                            &params,
                                        )
                                    {
                                        prompts_for_reader
                                            .lock()
                                            .await
                                            .insert(key, id_val.clone());
                                        let _ = app_for_reader.emit(
                                            "agent_event",
                                            json!({
                                                "sessionId": sid_for_reader,
                                                "event": UnifiedEvent::UserPrompt { request: prompt_req },
                                            }),
                                        );
                                    } else {
                                        let reply = json!({
                                            "jsonrpc": "2.0",
                                            "id": id_val,
                                            "result": { "answers": {} }
                                        });
                                        let _ = write_frame_raw(&stdin_for_reader, &reply).await;
                                    }
                                } else if let Some((payload, kind)) =
                                    protocol::translate_codex_approval_request(
                                        m,
                                        format!(
                                            "cdx-perm-{}",
                                            req_counter.fetch_add(1, Ordering::SeqCst)
                                        ),
                                        &params,
                                    )
                                {
                                    perms_for_reader.lock().await.insert(
                                        payload.id.clone(),
                                        PendingCodexPermission {
                                            rpc_id: id_val.clone(),
                                            kind,
                                        },
                                    );
                                    let _ = app_for_reader.emit(
                                        "agent_event",
                                        json!({
                                            "sessionId": sid_for_reader,
                                            "event": UnifiedEvent::PermissionRequest { request: payload },
                                        }),
                                    );
                                } else {
                                    // 未知反向请求立即返回标准 MethodNotFound，防止 app-server 永久挂起
                                    let err_resp = json!({
                                        "jsonrpc": "2.0",
                                        "id": id_val,
                                        "error": {
                                            "code": -32601,
                                            "message": format!("Unsupported client request: {m}")
                                        }
                                    });
                                    let _ = write_frame_raw(&stdin_for_reader, &err_resp).await;
                                }
                            }
                            // 3. ServerNotification (有 method 无 id) → 实时流式事件翻译
                            (Some(m), None) => {
                                let params = frame.get("params").cloned().unwrap_or(Value::Null);

                                // 同步会话元数据与活跃轮次 ID
                                match m {
                                    "turn/started" => {
                                        if let Some(tid) = params
                                            .get("turn")
                                            .and_then(|t| t.get("id"))
                                            .and_then(|v| v.as_str())
                                        {
                                            *active_turn_for_reader.lock().await =
                                                Some(tid.to_string());
                                        }
                                    }
                                    "turn/completed" => {
                                        *active_turn_for_reader.lock().await = None;
                                        stats_for_reader.lock().await.assistant_messages += 1;
                                    }
                                    "thread/started" => {
                                        if let Some(p) = params
                                            .get("thread")
                                            .and_then(|t| t.get("path"))
                                            .and_then(|v| v.as_str())
                                            .map(history::strip_verbatim_prefix)
                                            .filter(|s| !s.is_empty())
                                        {
                                            let mut sp = session_path_for_reader.lock().await;
                                            if sp.as_deref() != Some(p.as_str()) {
                                                *sp = Some(p.clone());
                                                let _ = app_for_reader.emit(
                                                    "agent_event",
                                                    json!({
                                                        "sessionId": sid_for_reader,
                                                        "event": UnifiedEvent::SessionMeta {
                                                            session_path: Some(p),
                                                            remote_session_id: None,
                                                            model: None,
                                                            permission_mode: None,
                                                        }
                                                    }),
                                                );
                                            }
                                        }
                                    }
                                    "thread/tokenUsage/updated" => {
                                        if let Some((total, last, window)) =
                                            protocol::parse_token_usage_update(&params)
                                        {
                                            stats_for_reader
                                                .lock()
                                                .await
                                                .apply_usage_update(total, last, window);
                                        }
                                    }
                                    _ => {}
                                }

                                let events = translator_for_reader
                                    .lock()
                                    .await
                                    .translate_notification(m, &params);
                                for ev in events {
                                    let extra_plan = match &ev {
                                        UnifiedEvent::ToolStart {
                                            tool_call_id,
                                            tool_name,
                                            args,
                                        } => tool_plan_tracker.ingest_tool_start(
                                            tool_call_id,
                                            tool_name,
                                            args,
                                        ),
                                        UnifiedEvent::ToolEnd {
                                            tool_call_id,
                                            result,
                                            ..
                                        } => tool_plan_tracker.ingest_tool_end(tool_call_id, result),
                                        _ => None,
                                    };
                                    let _ = app_for_reader.emit(
                                        "agent_event",
                                        json!({ "sessionId": sid_for_reader, "event": ev }),
                                    );
                                    if let Some(plan) = extra_plan {
                                        let _ = app_for_reader.emit(
                                            "agent_event",
                                            json!({
                                                "sessionId": sid_for_reader,
                                                "event": UnifiedEvent::PlanUpdate { plan }
                                            }),
                                        );
                                    }
                                }
                            }
                            (None, None) => {}
                        }
                    }
                    Err(e) => {
                        eprintln!("[codex_backend] 读 stdout 出错: {e}");
                        break;
                    }
                }
            }
        });

        let stderr_tail: StderrTail =
            Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LIMIT)));
        if let Some(stderr) = stderr {
            let tail_for_reader = stderr_tail.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::with_capacity(1024);
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let s = String::from_utf8_lossy(&buf);
                            let line = s.trim_end();
                            eprintln!("[codex stderr] {line}");
                            if !line.trim().is_empty() {
                                let mut guard = tail_for_reader.lock().await;
                                if guard.len() >= STDERR_TAIL_LIMIT {
                                    guard.pop_front();
                                }
                                guard.push_back(line.to_string());
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let mut backend = Self {
            app,
            session_id,
            cwd: cwd.clone(),
            thread_id: String::new(),
            session_path,
            models_catalog: Vec::new(),
            current_model,
            current_effort,
            permission_mode: permission_mode_arc,
            active_turn_id,
            translator,
            stats,
            initial_entries: Vec::new(),
            initial_plan: None,
            migration_notice: None,
            fallback_history_thread_id: None,
            child,
            stdin,
            pending,
            pending_permissions,
            pending_prompts,
            stderr_tail,
            id_counter: Arc::new(AtomicU64::new(1)),
        };

        // 握手 1: initialize
        let init_id = backend.next_id();
        let init_resp = match backend
            .send_rpc_wait(
                protocol::build_initialize_request(init_id),
                init_id,
                CODEX_INIT_TIMEOUT_SECS,
            )
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                let diag = backend.stderr_summary().await;
                let _ = backend.stop().await;
                return Err(format!("Codex App Server initialize 握手失败: {e}{diag}"));
            }
        };
        if let Some(err) = init_resp.get("error") {
            let diag = backend.stderr_summary().await;
            let _ = backend.stop().await;
            return Err(protocol::format_codex_rpc_error("Codex initialize", err, &diag));
        }

        // 握手 2: initialized 通知
        if let Err(e) = backend
            .write_frame(&protocol::build_initialized_notification())
            .await
        {
            let _ = backend.stop().await;
            return Err(format!("发送 Codex initialized 失败: {e}"));
        }

        // 握手 3 (best-effort): model/list 拉取模型与推理强度目录
        let mid = backend.next_id();
        if let Ok(resp) = backend
            .send_rpc_wait(protocol::build_model_list_request(mid), mid, 12)
            .await
        {
            if let Some(res) = resp.get("result") {
                backend.models_catalog = protocol::parse_model_list(res);
            }
        }

        // 握手 4: thread/resume (历史会话) 或 thread/start (新会话)
        // 若历史会话因原供应商未配置 (`modelProviderNotConfigured`) 被拒，自动走方案 A 无损迁移：
        // 只读解压/解析原 rollout (.jsonl/.jsonl.zst) → 递归剥离跨供应商不可解密的 encrypted_content
        // → 经 `thread/resume(history=...)` 在当前默认登录下实例化原生新线程，零修改原文件与数据库。
        let resume_tid = resume_session_path
            .as_deref()
            .and_then(history::extract_codex_thread_id);
        let mut migrated_from: Option<(Option<String>, Option<String>)> = None;

        let thread_resp = if let Some(ref tid) = resume_tid {
            let rid = backend.next_id();
            let req = protocol::build_thread_resume_request(
                rid,
                tid,
                &cwd,
                model.as_deref(),
                Some(initial_mode.as_str()),
            );
            match backend
                .send_rpc_wait(req, rid, CODEX_SESSION_TIMEOUT_SECS)
                .await
            {
                Ok(resp) if resp.get("error").is_none() => resp,
                Ok(resp) => {
                    let err_val = resp.get("error").unwrap_or(&Value::Null);
                    if let Some(missing_provider) = protocol::extract_missing_model_provider(err_val)
                    {
                        let orig_meta = history::lookup_codex_thread_meta(tid);
                        match history::load_codex_migration_history(
                            tid,
                            resume_session_path.as_deref().map(Path::new),
                        ) {
                            Ok(clean_history) => {
                                let mig_id = backend.next_id();
                                let mig_req = protocol::build_thread_resume_with_history_request(
                                    mig_id,
                                    tid,
                                    clean_history,
                                    &cwd,
                                    model.as_deref(),
                                    Some(initial_mode.as_str()),
                                );
                                match backend
                                    .send_rpc_wait(mig_req, mig_id, CODEX_SESSION_TIMEOUT_SECS)
                                    .await
                                {
                                    Ok(mig_resp) if mig_resp.get("error").is_none() => {
                                        migrated_from = Some((missing_provider, orig_meta.title));
                                        mig_resp
                                    }
                                    Ok(mig_resp) => {
                                        let diag = backend.stderr_summary().await;
                                        let _ = backend.stop().await;
                                        return Err(protocol::format_codex_rpc_error(
                                            "自动迁移 Codex 会话至当前登录",
                                            mig_resp.get("error").unwrap_or(&Value::Null),
                                            &diag,
                                        ));
                                    }
                                    Err(e) => {
                                        let diag = backend.stderr_summary().await;
                                        let _ = backend.stop().await;
                                        return Err(format!(
                                            "自动迁移 Codex 会话超时/失败: {e}{diag}"
                                        ));
                                    }
                                }
                            }
                            Err(load_err) => {
                                let diag = backend.stderr_summary().await;
                                let _ = backend.stop().await;
                                let base = protocol::format_codex_rpc_error(
                                    "恢复 Codex 会话",
                                    err_val,
                                    &diag,
                                );
                                return Err(format!("{base}（尝试自动迁移失败：{load_err}）"));
                            }
                        }
                    } else {
                        let diag = backend.stderr_summary().await;
                        let _ = backend.stop().await;
                        return Err(protocol::format_codex_rpc_error(
                            "恢复 Codex 会话",
                            err_val,
                            &diag,
                        ));
                    }
                }
                Err(e) => {
                    let diag = backend.stderr_summary().await;
                    let _ = backend.stop().await;
                    return Err(format!("恢复 Codex 会话超时/失败: {e}{diag}"));
                }
            }
        } else {
            let sid_req = backend.next_id();
            let req = protocol::build_thread_start_request(
                sid_req,
                &cwd,
                model.as_deref(),
                &initial_mode,
            );
            match backend
                .send_rpc_wait(req, sid_req, CODEX_SESSION_TIMEOUT_SECS)
                .await
            {
                Ok(resp) if resp.get("error").is_none() => resp,
                Ok(resp) => {
                    let diag = backend.stderr_summary().await;
                    let _ = backend.stop().await;
                    return Err(protocol::format_codex_rpc_error(
                        "创建 Codex 会话",
                        resp.get("error").unwrap_or(&Value::Null),
                        &diag,
                    ));
                }
                Err(e) => {
                    let diag = backend.stderr_summary().await;
                    let _ = backend.stop().await;
                    return Err(format!("创建 Codex 会话超时/失败: {e}{diag}"));
                }
            }
        };

        let result = thread_resp.get("result").unwrap_or(&Value::Null);
        let thread_obj = result.get("thread").unwrap_or(&Value::Null);
        let Some(tid) = thread_obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
        else {
            let diag = backend.stderr_summary().await;
            let _ = backend.stop().await;
            return Err(format!("Codex 会话响应缺少 thread.id{diag}"));
        };
        backend.thread_id = tid.clone();

        let resolved_path = thread_obj
            .get("path")
            .and_then(|v| v.as_str())
            .map(history::strip_verbatim_prefix)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                resume_session_path
                    .as_deref()
                    .map(history::strip_verbatim_prefix)
                    .filter(|s| !s.is_empty())
            });
        *backend.session_path.lock().await = resolved_path.clone();

        let resolved_model = result
            .get("model")
            .and_then(|v| v.as_str())
            .or_else(|| thread_obj.get("model").and_then(|v| v.as_str()))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                backend
                    .models_catalog
                    .iter()
                    .find(|m| m.is_default)
                    .or_else(|| backend.models_catalog.first())
                    .map(|m| m.id.clone())
            });
        *backend.current_model.lock().await = resolved_model.clone();

        let allowed_efforts =
            effort_levels_for_model(&backend.models_catalog, resolved_model.as_deref());
        let resolved_effort = result
            .get("reasoningEffort")
            .and_then(|v| v.as_str())
            .or_else(|| thread_obj.get("reasoningEffort").and_then(|v| v.as_str()))
            .map(str::trim)
            .filter(|s| !s.is_empty() && allowed_efforts.iter().any(|lv| lv == s))
            .map(|s| s.to_string())
            .or_else(|| {
                resolved_model
                    .as_deref()
                    .and_then(|id| find_model(&backend.models_catalog, id))
                    .and_then(|m| m.default_effort.clone())
                    .filter(|e| allowed_efforts.iter().any(|lv| lv == e))
            })
            .or_else(|| allowed_efforts.first().cloned())
            .unwrap_or_else(|| "medium".to_string());
        *backend.current_effort.lock().await = resolved_effort;

        let resolved_mode = protocol::infer_mode_from_thread_response(result);
        *backend.permission_mode.lock().await = resolved_mode.clone();

        // 跨供应商迁移收尾: 同步原会话标题 (best-effort) 并记录前端轻提示与原线程回放 ID
        if let Some((missing_provider, orig_title)) = migrated_from {
            let target_title = orig_title
                .or_else(|| {
                    thread_obj
                        .get("preview")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.chars().take(120).collect())
                });
            if let Some(title) = target_title {
                let nid = backend.next_id();
                let _ = backend
                    .send_rpc_wait(protocol::build_thread_set_name_request(nid, &tid, &title), nid, 5)
                    .await;
            }
            backend.fallback_history_thread_id = resume_tid.clone();
            backend.migration_notice = Some(match missing_provider {
                Some(p) => format!("原会话供应商「{p}」未配置，已无损迁移至当前登录继续对话"),
                None => "原会话供应商未配置，已无损迁移至当前登录继续对话".to_string(),
            });
        }

        // 若是恢复历史会话: 优先毫秒直读 SQLite, 缺失时用 `thread/items/list` 兜底拉取
        // 跨供应商迁移场景下先读原 thread_id 的完整结构化历史，避免新线程刚创建尚无 SQLite 投影导致空屏
        if let Some(ref orig_tid) = resume_tid {
            let mut entries = if backend.fallback_history_thread_id.is_some() {
                history::read_codex_session_entries(
                    orig_tid,
                    resume_session_path.as_deref().map(Path::new),
                )
            } else {
                Vec::new()
            };
            if entries.is_empty() {
                entries = history::read_codex_session_entries(
                    &tid,
                    resolved_path.as_deref().map(Path::new),
                );
            }
            if entries.is_empty() {
                let iid = backend.next_id();
                if let Ok(resp) = backend
                    .send_rpc_wait(
                        protocol::build_thread_items_list_request(iid, &tid, None, 200),
                        iid,
                        15,
                    )
                    .await
                {
                    if let Some(arr) = resp
                        .get("result")
                        .and_then(|r| r.get("data"))
                        .and_then(|v| v.as_array())
                    {
                        let items: Vec<(Value, Option<String>)> = arr
                            .iter()
                            .filter_map(|e| e.get("item").cloned().map(|it| (it, None)))
                            .collect();
                        entries = protocol::thread_items_to_entries(&items);
                    }
                }
            }
            let initial_plan = crate::backends::plan::derive_active_plan_from_entries(&entries);
            backend.initial_entries = entries;
            backend.initial_plan = initial_plan;
        }

        let _ = backend.app.emit(
            "agent_event",
            json!({
                "sessionId": backend.session_id,
                "event": UnifiedEvent::SessionMeta {
                    session_path: resolved_path,
                    remote_session_id: Some(tid),
                    model: resolved_model,
                    permission_mode: Some(resolved_mode),
                }
            }),
        );

        Ok(backend)
    }

    async fn stderr_summary(&self) -> String {
        let guard = self.stderr_tail.lock().await;
        if guard.is_empty() {
            String::new()
        } else {
            let joined: Vec<&str> = guard.iter().map(String::as_str).collect();
            format!(" (stderr: {})", joined.join(" | "))
        }
    }

    fn next_id(&self) -> u64 {
        self.id_counter.fetch_add(1, Ordering::SeqCst)
    }

    async fn write_frame(&self, frame: &Value) -> Result<(), String> {
        write_frame_raw(&self.stdin, frame).await
    }

    async fn send_rpc_wait(
        &self,
        frame: Value,
        id: u64,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write_frame(&frame).await?;
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                Err("Codex 响应通道关闭".into())
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("等待 Codex 响应超时 ({timeout_secs}s)"))
            }
        }
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn take_initial_entries(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.initial_entries)
    }

    pub fn take_initial_plan(&mut self) -> Option<PlanSnapshot> {
        self.initial_plan.take()
    }

    pub fn take_migration_notice(&mut self) -> Option<String> {
        self.migration_notice.take()
    }

    pub async fn session_path(&self) -> Option<String> {
        self.session_path.lock().await.clone()
    }

    pub async fn current_permission_mode(&self) -> String {
        self.permission_mode.lock().await.clone()
    }

    /// 异步非阻塞发起 `turn/start`:
    /// 写完请求立即释放全局 `RuntimePool` 锁，由后台 task 检查 RPC 错误并让事件流自然收尾。
    pub async fn send_prompt(
        &mut self,
        message: String,
        images: Option<Vec<Value>>,
    ) -> Result<Value, String> {
        self.translator.lock().await.mark_prompt_dispatched();
        let _ = self.app.emit(
            "agent_event",
            json!({ "sessionId": self.session_id, "event": UnifiedEvent::TurnStart }),
        );
        let _ = self.app.emit(
            "agent_event",
            json!({
                "sessionId": self.session_id,
                "event": UnifiedEvent::AssistantStart { message_id: None }
            }),
        );

        let model = self.current_model.lock().await.clone();
        let effort = self.current_effort.lock().await.clone();
        let mode = self.permission_mode.lock().await.clone();
        let req_id = self.next_id();
        let frame = protocol::build_turn_start_request(
            req_id,
            &self.thread_id,
            &message,
            images.as_deref(),
            &self.cwd,
            model.as_deref(),
            Some(effort.as_str()),
            &mode,
        );

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(req_id, tx);
        if let Err(e) = self.write_frame(&frame).await {
            self.pending.lock().await.remove(&req_id);
            let _ = self.app.emit(
                "agent_event",
                json!({ "sessionId": self.session_id, "event": UnifiedEvent::TurnSettled }),
            );
            return Err(e);
        }
        self.stats.lock().await.user_messages += 1;

        let app = self.app.clone();
        let sid = self.session_id.clone();
        let active_turn = self.active_turn_id.clone();
        tokio::spawn(async move {
            if let Ok(resp) = rx.await {
                if let Some(err) = resp.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Codex turn/start 失败");
                    let _ = app.emit(
                        "agent_event",
                        json!({
                            "sessionId": sid,
                            "event": UnifiedEvent::AssistantEnd {
                                usage: None,
                                stop_reason: Some("failed".into()),
                                error_message: Some(msg.to_string()),
                            }
                        }),
                    );
                    let _ = app.emit(
                        "agent_event",
                        json!({ "sessionId": sid, "event": UnifiedEvent::TurnSettled }),
                    );
                } else if let Some(tid) = resp
                    .get("result")
                    .and_then(|r| r.get("turn"))
                    .and_then(|t| t.get("id"))
                    .and_then(|v| v.as_str())
                {
                    *active_turn.lock().await = Some(tid.to_string());
                }
            }
        });

        Ok(json!({ "disposition": "started" }))
    }

    pub async fn steer(&mut self, message: String, images: Option<Vec<Value>>) -> Result<(), String> {
        let Some(turn_id) = self.active_turn_id.lock().await.clone() else {
            return Err("当前没有正在执行的 Codex 轮次，无法插话".into());
        };
        let req_id = self.next_id();
        let frame = protocol::build_turn_steer_request(
            req_id,
            &self.thread_id,
            &turn_id,
            &message,
            images.as_deref(),
        );
        let resp = self.send_rpc_wait(frame, req_id, 10).await?;
        if let Some(err) = resp.get("error") {
            let msg = err
                .get("message")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| err.to_string());
            return Err(format!("Codex 插话失败: {msg}"));
        }
        let preview: String = message.trim().chars().take(60).collect();
        let _ = self.app.emit(
            "agent_event",
            json!({
                "sessionId": self.session_id,
                "event": UnifiedEvent::Notice {
                    id: None,
                    notify_type: NotifyLevel::Info,
                    message: format!("已向 Codex 发送插话指导: {preview}"),
                    from_extension: false,
                }
            }),
        );
        Ok(())
    }

    pub async fn abort(&mut self) -> Result<(), String> {
        let Some(turn_id) = self.active_turn_id.lock().await.clone() else {
            return Ok(());
        };
        let req_id = self.next_id();
        let frame = protocol::build_turn_interrupt_request(req_id, &self.thread_id, &turn_id);
        let _ = self.send_rpc_wait(frame, req_id, 8).await?;
        Ok(())
    }

    pub async fn respond_permission(
        &mut self,
        request_id: String,
        allow: bool,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let pending = self
            .pending_permissions
            .lock()
            .await
            .remove(&request_id)
            .ok_or_else(|| "未找到对应的 Codex 权限请求".to_string())?;
        let resp = protocol::build_codex_approval_response(
            pending.rpc_id,
            &pending.kind,
            allow,
            option_id.as_deref(),
        );
        self.write_frame(&resp).await
    }

    pub async fn respond_user_prompt(
        &mut self,
        request_id: String,
        response: UserPromptResponse,
    ) -> Result<(), String> {
        let rpc_id = self
            .pending_prompts
            .lock()
            .await
            .remove(&request_id)
            .ok_or_else(|| "未找到对应的 Codex 提问请求".to_string())?;
        let resp = protocol::build_codex_user_input_response(rpc_id, response);
        self.write_frame(&resp).await
    }

    pub async fn set_session_name(&mut self, name: String) -> Result<(), String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("会话名称不能为空".into());
        }
        let req_id = self.next_id();
        let req = protocol::build_thread_set_name_request(req_id, &self.thread_id, trimmed);
        let resp = self.send_rpc_wait(req, req_id, 10).await?;
        if let Some(err) = resp.get("error") {
            return Err(format!("Codex 重命名会话失败: {err}"));
        }
        Ok(())
    }

    fn display_name_for_model(&self, model_id: &str) -> String {
        find_model(&self.models_catalog, model_id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| model_id.to_string())
    }

    pub async fn get_state(&mut self) -> Result<Value, String> {
        let model = self.current_model.lock().await.clone();
        let effort = self.current_effort.lock().await.clone();
        let mode = self.permission_mode.lock().await.clone();
        let path = self.session_path.lock().await.clone();
        Ok(json!({
            "remoteSessionId": self.thread_id,
            "sessionFile": path,
            "model": model.as_ref().map(|id| json!({
                "id": id,
                "name": self.display_name_for_model(id),
                "provider": "openai",
            })),
            "thinkingLevel": effort,
            "permissionMode": mode,
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
                    "provider": "openai",
                })
            })
            .collect();
        if let Some(cur) = self.current_model.lock().await.clone() {
            if find_model(&self.models_catalog, &cur).is_none() {
                models.insert(0, json!({ "id": cur, "name": cur, "provider": "openai" }));
            }
        }
        Ok(json!({ "models": models }))
    }

    pub async fn set_model(&mut self, _provider: String, model_id: String) -> Result<Value, String> {
        let trimmed = model_id.trim();
        if trimmed.is_empty() {
            return Err("模型 ID 不能为空".into());
        }
        *self.current_model.lock().await = Some(trimmed.to_string());

        // 切模型后若当前推理强度不在新模型支持档位内, 自动回落对齐
        let allowed = effort_levels_for_model(&self.models_catalog, Some(trimmed));
        let mut eff = self.current_effort.lock().await;
        if !allowed.iter().any(|lv| lv == eff.as_str()) {
            let fallback = find_model(&self.models_catalog, trimmed)
                .and_then(|m| m.default_effort.clone())
                .filter(|d| allowed.iter().any(|lv| lv == d))
                .or_else(|| allowed.first().cloned())
                .unwrap_or_else(|| "medium".to_string());
            *eff = fallback;
        }
        drop(eff);

        Ok(json!({
            "id": trimmed,
            "name": self.display_name_for_model(trimmed),
            "provider": "openai",
        }))
    }

    pub async fn get_available_thinking_levels(&mut self) -> Result<Value, String> {
        let cur_model = self.current_model.lock().await.clone();
        let levels = effort_levels_for_model(&self.models_catalog, cur_model.as_deref());
        let cur = self.current_effort.lock().await.clone();
        Ok(json!({
            "levels": levels,
            "current": cur,
        }))
    }

    pub async fn set_thinking_level(&mut self, level: String) -> Result<Value, String> {
        let cur_model = self.current_model.lock().await.clone();
        let allowed = effort_levels_for_model(&self.models_catalog, cur_model.as_deref());
        if !allowed.iter().any(|lv| lv == &level) {
            return Err(format!(
                "当前 Codex 模型不支持的推理强度: {level}（可选: {}）",
                allowed.join(", ")
            ));
        }
        *self.current_effort.lock().await = level.clone();
        Ok(json!({ "level": level }))
    }

    pub async fn cycle_thinking_level(&mut self) -> Result<Value, String> {
        let cur_model = self.current_model.lock().await.clone();
        let levels = effort_levels_for_model(&self.models_catalog, cur_model.as_deref());
        let cur = self.current_effort.lock().await.clone();
        if levels.len() <= 1 {
            return Ok(json!({ "level": cur }));
        }
        let next_idx = levels
            .iter()
            .position(|lv| lv == &cur)
            .map(|i| (i + 1) % levels.len())
            .unwrap_or(0);
        let next = levels[next_idx].clone();
        self.set_thinking_level(next).await
    }

    pub async fn set_permission_mode(&mut self, mode: String) -> Result<Value, String> {
        if !protocol::CODEX_PERMISSION_MODES.contains(&mode.as_str()) {
            return Err(format!(
                "不支持的 Codex 权限模式: {mode}（可选: {}）",
                protocol::CODEX_PERMISSION_MODES.join(", ")
            ));
        }
        *self.permission_mode.lock().await = mode.clone();
        Ok(json!({ "permissionMode": mode }))
    }

    pub async fn get_entries(&mut self) -> Result<Value, String> {
        let path = self.session_path.lock().await.clone();
        let mut entries =
            history::read_codex_session_entries(&self.thread_id, path.as_deref().map(Path::new));
        if entries.is_empty() {
            if let Some(ref orig_tid) = self.fallback_history_thread_id {
                entries = history::read_codex_session_entries(orig_tid, None);
            }
        }
        Ok(json!({ "entries": entries }))
    }

    pub async fn get_session_stats(&mut self) -> Result<Value, String> {
        let st = self.stats.lock().await;
        Ok(st.to_stats_json())
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        kill_process_tree(&mut self.child).await;
        // 短等待确保 Windows 下子进程退出、尽快释放 `~/.codex/thread-writer-locks/` 写锁句柄
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(800),
            self.child.wait(),
        )
        .await;
        Ok(())
    }
}

async fn write_frame_raw(stdin: &Arc<Mutex<ChildStdin>>, frame: &Value) -> Result<(), String> {
    let line = serde_json::to_string(frame).map_err(|e| e.to_string())?;
    let mut guard = stdin.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("写 Codex stdin 失败: {e}"))?;
    guard
        .write_all(b"\n")
        .await
        .map_err(|e| format!("写换行失败: {e}"))?;
    guard
        .flush()
        .await
        .map_err(|e| format!("flush Codex stdin 失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_session_stats_formats_context_and_tokens_without_double_count() {
        let mut st = CodexSessionStats::default();
        st.user_messages = 1;
        st.assistant_messages = 1;
        st.apply_usage_update(
            CodexTokenBreakdown {
                total_tokens: 27231,
                input_tokens: 27047,
                cached_input_tokens: 14976,
                cache_write_input_tokens: 0,
                output_tokens: 184,
                reasoning_output_tokens: 50,
            },
            CodexTokenBreakdown {
                total_tokens: 27231,
                input_tokens: 27047,
                cached_input_tokens: 14976,
                cache_write_input_tokens: 0,
                output_tokens: 184,
                reasoning_output_tokens: 50,
            },
            Some(475_000),
        );

        let v = st.to_stats_json();
        assert_eq!(v["contextUsage"]["tokens"], 27231);
        assert_eq!(v["contextUsage"]["contextWindow"], 475_000);
        assert!((v["contextUsage"]["percent"].as_f64().unwrap() - 5.733).abs() < 0.01);
        assert_eq!(v["tokens"]["input"], 12071);
        assert_eq!(v["tokens"]["cacheRead"], 14976);
        assert_eq!(v["tokens"]["output"], 184);
        assert_eq!(v["tokens"]["total"], 27231);
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "实机验证: 启动本机 codex app-server --stdio 完成 initialize + model/list 握手"]
    async fn codex_app_server_live_handshake() {
        let mut cmd = build_cli_command("codex", &["app-server", "--stdio"]);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().expect("spawn codex app-server");
        let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let mut stdout = BufReader::new(child.stdout.take().unwrap());

        write_frame_raw(&stdin, &protocol::build_initialize_request(1))
            .await
            .unwrap();

        async fn read_rpc(
            stdout: &mut BufReader<tokio::process::ChildStdout>,
            target_id: u64,
        ) -> Value {
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                loop {
                    let mut line = String::new();
                    let n = stdout.read_line(&mut line).await.unwrap();
                    assert!(n > 0, "unexpected EOF waiting for id {target_id}");
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        if v.get("method").is_none()
                            && v.get("id").and_then(|x| x.as_u64()) == Some(target_id)
                        {
                            return v;
                        }
                    }
                }
            })
            .await
            .expect("rpc timeout")
        }

        let r1 = read_rpc(&mut stdout, 1).await;
        assert!(r1.get("error").is_none(), "init error: {r1}");
        write_frame_raw(&stdin, &protocol::build_initialized_notification())
            .await
            .unwrap();

        write_frame_raw(&stdin, &protocol::build_model_list_request(2))
            .await
            .unwrap();
        let r2 = read_rpc(&mut stdout, 2).await;
        assert!(r2.get("error").is_none(), "model/list error: {r2}");
        let models = protocol::parse_model_list(r2.get("result").unwrap_or(&Value::Null));
        assert!(!models.is_empty(), "expected non-empty codex model catalog");

        kill_process_tree(&mut child).await;
    }
}
