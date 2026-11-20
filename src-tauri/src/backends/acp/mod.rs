//! 通用 ACP (Agent Client Protocol) v1 后端驱动。
//!
//! 首个内置预设为 **Antigravity CLI (`agy acp`)**; 任何遵循 ACP v1 (JSON-RPC 2.0 over stdio)
//! 的 CLI 均可经 `AcpLaunchSpec` 复用本驱动, 无需另写协议层。
//!
//! 并发铁律:
//! - `session/prompt` 是覆盖整轮执行的长 RPC, `send_prompt` 写完请求即释放 `RuntimePool` 锁,
//!   由后台 task 等待 `oneshot` 并在结束时 emit `TurnSettled`, 保证 `abort` (`session/cancel`)
//!   与工具权限审批 (`respond_permission`) 永不被锁死。

pub mod protocol;

use crate::backends::process::{build_cli_command, kill_process_tree, strip_newline};
use crate::backends::{AgentKind, MessageUsage, NotifyLevel, PermissionOption, UnifiedEvent};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

const ACP_INIT_TIMEOUT_SECS: u64 = 15;
const ACP_SESSION_TIMEOUT_SECS: u64 = 30;
const STDERR_TAIL_LIMIT: usize = 8;

type PendingRpc = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;
type StderrTail = Arc<Mutex<VecDeque<String>>>;

struct PendingAcpPermission {
    rpc_id: Value,
    options: Vec<PermissionOption>,
}

/// 启动任意 ACP 兼容 CLI 的配置规格。
pub struct AcpLaunchSpec {
    pub kind: AgentKind,
    pub program: String,
    pub args: Vec<String>,
}

impl AcpLaunchSpec {
    pub fn agy(cli_override: Option<String>) -> Self {
        let program = cli_override
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "agy".to_string());
        Self {
            kind: AgentKind::Agy,
            program,
            args: vec!["acp".to_string()],
        }
    }
}

pub struct AcpBackend {
    app: AppHandle,
    session_id: String,
    acp_session_id: String,
    current_model: Option<(String, String)>,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingRpc,
    pending_permissions: Arc<Mutex<HashMap<String, PendingAcpPermission>>>,
    stderr_tail: StderrTail,
    id_counter: Arc<AtomicU64>,
}

fn extract_current_model(result: &Value) -> Option<(String, String)> {
    let models = result.get("models")?;
    let current_id = models.get("currentModelId")?.as_str()?.trim();
    if current_id.is_empty() {
        return None;
    }
    let display_name = models
        .get("availableModels")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|m| {
                if m.get("modelId").and_then(|v| v.as_str()) == Some(current_id) {
                    m.get("name").and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
        })
        .unwrap_or_else(|| current_id.to_string());
    Some((current_id.to_string(), display_name))
}

fn extract_prompt_usage(result: &Value) -> Option<MessageUsage> {
    let u = result.get("usage")?;
    let input = u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let output = u.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let cache_read = u
        .get("cachedReadTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_write = u
        .get("cachedWriteTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(MessageUsage {
        input,
        output,
        cache_read,
        cache_write,
        cost: None,
    })
}

impl AcpBackend {
    pub async fn spawn(
        app: AppHandle,
        session_id: String,
        cwd: String,
        spec: AcpLaunchSpec,
        resume_session_id: Option<String>,
    ) -> Result<Self, String> {
        let arg_refs: Vec<&str> = spec.args.iter().map(String::as_str).collect();
        let mut cmd = build_cli_command(&spec.program, &arg_refs);
        cmd.current_dir(&cwd);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "启动 {} ({}) 失败: {e}。可在设置 → Agent 运行时中检查或覆盖可执行文件路径",
                spec.kind.label(),
                spec.program
            )
        })?;

        let stdin = Arc::new(Mutex::new(
            child
                .stdin
                .take()
                .ok_or_else(|| format!("无法获取 {} stdin", spec.program))?,
        ));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("无法获取 {} stdout", spec.program))?;
        let stderr = child.stderr.take();

        let pending: PendingRpc = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();
        let pending_permissions: Arc<Mutex<HashMap<String, PendingAcpPermission>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let perms_for_reader = pending_permissions.clone();
        let perm_counter = Arc::new(AtomicU64::new(0));

        let app_for_reader = app.clone();
        let sid_for_reader = session_id.clone();
        let kind = spec.kind;
        let kind_label = kind.label().to_string();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::with_capacity(8192);
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => {
                        let ev = UnifiedEvent::ProcessExit {
                            agent_kind: kind,
                            message: format!("{kind_label} (ACP) 进程已退出"),
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

                        let has_method = frame.get("method").and_then(|v| v.as_str());
                        let rpc_id = frame.get("id");

                        match (has_method, rpc_id) {
                            // 1. Response 帧 (无 method, 有 id) → 唤醒 pending oneshot
                            (None, Some(id_val)) => {
                                if let Some(num_id) = id_val.as_u64() {
                                    let mut guard = pending_for_reader.lock().await;
                                    if let Some(tx) = guard.remove(&num_id) {
                                        let _ = tx.send(frame);
                                    }
                                }
                            }
                            // 2. Agent 反向请求 (有 method 且有 id) → 权限审批
                            (Some("session/request_permission"), Some(id_val)) => {
                                let params = frame.get("params").cloned().unwrap_or(Value::Null);
                                let req_key = format!(
                                    "acp-perm-{}",
                                    perm_counter.fetch_add(1, Ordering::SeqCst)
                                );
                                let payload = protocol::translate_acp_permission_request(
                                    req_key.clone(),
                                    &params,
                                );
                                perms_for_reader.lock().await.insert(
                                    req_key,
                                    PendingAcpPermission {
                                        rpc_id: id_val.clone(),
                                        options: payload.options.clone(),
                                    },
                                );
                                let _ = app_for_reader.emit(
                                    "agent_event",
                                    json!({
                                        "sessionId": sid_for_reader,
                                        "event": UnifiedEvent::PermissionRequest { request: payload }
                                    }),
                                );
                            }
                            // 3. Notification: session/update → 翻译为 UnifiedEvent
                            (Some("session/update"), None) => {
                                let params = frame.get("params").cloned().unwrap_or(Value::Null);
                                for ev in protocol::translate_acp_update(&params) {
                                    let _ = app_for_reader.emit(
                                        "agent_event",
                                        json!({ "sessionId": sid_for_reader, "event": ev }),
                                    );
                                }
                            }
                            _ => {}
                        }
                    }
                    Err(e) => {
                        eprintln!("[acp_backend] 读 stdout 出错: {e}");
                        break;
                    }
                }
            }
        });

        let stderr_tail: StderrTail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LIMIT)));
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
                            eprintln!("[acp stderr] {line}");
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

        let id_counter = Arc::new(AtomicU64::new(1));
        let mut backend = Self {
            app,
            session_id,
            acp_session_id: String::new(),
            current_model: None,
            child,
            stdin,
            pending,
            pending_permissions,
            stderr_tail,
            id_counter,
        };

        // 握手 1: initialize
        let init_id = backend.next_id();
        let init_resp = match backend
            .send_rpc_wait(
                protocol::build_initialize_request(init_id),
                init_id,
                ACP_INIT_TIMEOUT_SECS,
            )
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                let diag = backend.stderr_summary().await;
                let _ = backend.stop().await;
                return Err(format!("ACP initialize 握手失败: {e}{diag}"));
            }
        };
        if let Some(err) = init_resp.get("error") {
            let diag = backend.stderr_summary().await;
            let _ = backend.stop().await;
            return Err(format!("ACP initialize 返回错误: {err}{diag}"));
        }

        // 握手 2: session/load (若有历史 ID) 或 session/new
        let (acp_sid, current_model) = if let Some(rid) = resume_session_id.filter(|s| !s.is_empty())
        {
            let lid = backend.next_id();
            match backend
                .send_rpc_wait(
                    protocol::build_session_load_request(lid, &rid, &cwd),
                    lid,
                    ACP_SESSION_TIMEOUT_SECS,
                )
                .await
            {
                Ok(resp) if resp.get("error").is_none() => {
                    let model = resp.get("result").and_then(extract_current_model);
                    (rid, model)
                }
                _ => backend.create_new_acp_session(&cwd).await?,
            }
        } else {
            backend.create_new_acp_session(&cwd).await?
        };
        backend.acp_session_id = acp_sid.clone();
        backend.current_model = current_model.clone();

        let _ = backend.app.emit(
            "agent_event",
            json!({
                "sessionId": backend.session_id,
                "event": UnifiedEvent::SessionMeta {
                    session_path: None,
                    remote_session_id: Some(acp_sid),
                    model: current_model.map(|(id, _)| id),
                    permission_mode: None,
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

    async fn create_new_acp_session(
        &mut self,
        cwd: &str,
    ) -> Result<(String, Option<(String, String)>), String> {
        let sid_req = self.next_id();
        let resp = match self
            .send_rpc_wait(
                protocol::build_session_new_request(sid_req, cwd),
                sid_req,
                ACP_SESSION_TIMEOUT_SECS,
            )
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                let diag = self.stderr_summary().await;
                let _ = self.stop().await;
                return Err(format!("ACP session/new 失败: {e}{diag}"));
            }
        };
        if let Some(err) = resp.get("error") {
            let diag = self.stderr_summary().await;
            let _ = self.stop().await;
            return Err(format!("ACP session/new 返回错误: {err}{diag}"));
        }
        let result = resp.get("result");
        let Some(sid) = result
            .and_then(|r| r.get("sessionId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        else {
            let diag = self.stderr_summary().await;
            let _ = self.stop().await;
            return Err(format!("ACP session/new 未返回 sessionId{diag}"));
        };
        let model = result.and_then(extract_current_model);
        Ok((sid, model))
    }

    fn next_id(&self) -> u64 {
        self.id_counter.fetch_add(1, Ordering::SeqCst)
    }

    async fn write_frame(&self, frame: &Value) -> Result<(), String> {
        let line = serde_json::to_string(frame).map_err(|e| e.to_string())?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("写 ACP stdin 失败: {e}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("写换行失败: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush ACP stdin 失败: {e}"))?;
        Ok(())
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
                Err("ACP 响应通道关闭".into())
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("等待 ACP 响应超时 ({timeout_secs}s)"))
            }
        }
    }

    /// 异步非阻塞发送 `session/prompt`:
    /// 立刻释放全局 RuntimePool 锁, 独立 task 等待整轮完成并 emit `TurnSettled`。
    pub async fn send_prompt(
        &mut self,
        message: String,
        images: Option<Vec<Value>>,
    ) -> Result<Value, String> {
        let req_id = self.next_id();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(req_id, tx);

        // 先行通知前端进入流式气泡占位
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

        let frame = protocol::build_session_prompt_request(
            req_id,
            &self.acp_session_id,
            &message,
            images.as_deref(),
        );
        if let Err(e) = self.write_frame(&frame).await {
            self.pending.lock().await.remove(&req_id);
            let _ = self.app.emit(
                "agent_event",
                json!({ "sessionId": self.session_id, "event": UnifiedEvent::TurnSettled }),
            );
            return Err(e);
        }

        let app = self.app.clone();
        let sid = self.session_id.clone();
        tokio::spawn(async move {
            let mut usage = None;
            let mut stop_reason = None;
            let mut error_message = None;
            match rx.await {
                Ok(resp) => {
                    if let Some(err) = resp.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("ACP 执行失败");
                        error_message = Some(msg.to_string());
                        let _ = app.emit(
                            "agent_event",
                            json!({
                                "sessionId": sid,
                                "event": UnifiedEvent::Notice {
                                    id: None,
                                    notify_type: NotifyLevel::Error,
                                    message: msg.to_string(),
                                    from_extension: false,
                                }
                            }),
                        );
                    } else if let Some(result) = resp.get("result") {
                        usage = extract_prompt_usage(result);
                        stop_reason = result
                            .get("stopReason")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                }
                Err(_) => {}
            }
            let _ = app.emit(
                "agent_event",
                json!({ "sessionId": sid, "event": UnifiedEvent::AssistantEnd {
                    usage,
                    stop_reason,
                    error_message,
                }}),
            );
            let _ = app.emit(
                "agent_event",
                json!({ "sessionId": sid, "event": UnifiedEvent::TurnSettled }),
            );
        });

        Ok(json!({ "disposition": "started" }))
    }

    pub async fn abort(&mut self) -> Result<(), String> {
        let notif = protocol::build_session_cancel_notification(&self.acp_session_id);
        self.write_frame(&notif).await
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
            .ok_or_else(|| "未找到对应的 ACP 权限请求".to_string())?;
        let resp = protocol::build_permission_response(
            pending.rpc_id,
            allow,
            option_id.as_deref(),
            &pending.options,
        );
        self.write_frame(&resp).await
    }

    pub async fn get_state(&mut self) -> Result<Value, String> {
        let model = self.current_model.as_ref().map(|(id, name)| {
            json!({
                "id": id,
                "name": name,
                "provider": "agy",
            })
        });
        Ok(json!({
            "remoteSessionId": self.acp_session_id,
            "model": model,
        }))
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
    fn extracts_current_model_and_prompt_usage() {
        let session_result = json!({
            "sessionId": "s-1",
            "models": {
                "currentModelId": "gemini-4-neon-high",
                "availableModels": [
                    { "modelId": "gemini-4-neon-high", "name": "Gemini 4 Neon (High)" },
                    { "modelId": "gemini-3.8-flash-high", "name": "Gemini 3.8 Flash (High)" }
                ]
            }
        });
        assert_eq!(
            extract_current_model(&session_result),
            Some((
                "gemini-4-neon-high".to_string(),
                "Gemini 4 Neon (High)".to_string()
            ))
        );

        let prompt_result = json!({
            "stopReason": "end_turn",
            "usage": {
                "inputTokens": 12097,
                "outputTokens": 75,
                "cachedReadTokens": 100,
                "cachedWriteTokens": 20
            }
        });
        assert_eq!(
            extract_prompt_usage(&prompt_result),
            Some(MessageUsage {
                input: 12097,
                output: 75,
                cache_read: 100,
                cache_write: 20,
                cost: None,
            })
        );
        assert_eq!(extract_prompt_usage(&json!({ "stopReason": "end_turn" })), None);
    }
}
