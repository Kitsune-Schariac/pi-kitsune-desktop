//! Claude Code CLI 双向 `stream-json` 后端驱动。
//!
//! 通信协议:
//! - 启动: `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-prompts host --permission-mode <mode>`
//! - 输入: NDJSON (`user` 消息 / `control_request` / `control_response`)
//! - 输出: 经 `translate::ClaudeStreamTranslator` 翻译为 `UnifiedEvent` 发往 `agent_event`

pub mod history;
pub mod translate;

use crate::backends::process::{build_cli_command, kill_process_tree, strip_newline};
use crate::backends::{AgentKind, UnifiedEvent};
use serde_json::{json, Value};
use std::collections::HashMap;
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
    effort: String,
    session_path: Option<String>,
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

                        // host → CLI 发出的 control_request 响应直接唤醒 pending channel
                        if frame.get("type").and_then(|v| v.as_str()) == Some("control_response") {
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

                        let events = translator.translate(&frame);
                        for ev in events {
                            // 同步缓存会话元数据与待审批请求输入
                            match &ev {
                                UnifiedEvent::SessionMeta {
                                    remote_session_id: rsid,
                                    model,
                                    permission_mode,
                                    ..
                                } => {
                                    if let Some(id) = rsid {
                                        *rsid_for_reader.lock().await = Some(id.clone());
                                    }
                                    if let Some(m) = model {
                                        *model_for_reader.lock().await = Some(m.clone());
                                    }
                                    if let Some(pm) = permission_mode {
                                        *pmode_for_reader.lock().await = pm.clone();
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

        Ok(Self {
            child,
            stdin,
            pending,
            id_counter: Arc::new(AtomicU64::new(0)),
            pending_permissions,
            remote_session_id,
            current_model,
            permission_mode: permission_mode_state,
            effort: "medium".to_string(),
            session_path,
        })
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
        let _ = self
            .send_control_request(
                json!({ "subtype": "set_model", "model": model_id }),
                10,
            )
            .await?;
        *self.current_model.lock().await = Some(model_id.clone());
        Ok(json!({
            "id": model_id,
            "name": model_id,
            "provider": "anthropic"
        }))
    }

    pub async fn set_permission_mode(&mut self, mode: String) -> Result<Value, String> {
        if !CLAUDE_PERMISSION_MODES.contains(&mode.as_str()) {
            return Err(format!("不支持的 Claude 权限模式: {mode}"));
        }
        let _ = self
            .send_control_request(
                json!({ "subtype": "set_permission_mode", "mode": mode }),
                10,
            )
            .await?;
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
        Ok(json!({
            "model": model.as_ref().map(|m| json!({
                "id": m,
                "name": m,
                "provider": "anthropic"
            })),
            "thinkingLevel": self.effort,
            "permissionMode": mode,
            "sessionFile": self.session_path,
            "remoteSessionId": rsid,
        }))
    }

    pub async fn get_available_models(&mut self) -> Result<Value, String> {
        let mut models = vec![
            json!({ "id": "default", "name": "default (推荐)", "provider": "anthropic" }),
            json!({ "id": "sonnet", "name": "sonnet", "provider": "anthropic" }),
            json!({ "id": "opus", "name": "opus", "provider": "anthropic" }),
            json!({ "id": "haiku", "name": "haiku", "provider": "anthropic" }),
        ];
        if let Some(cur) = self.current_model.lock().await.clone() {
            if !["default", "sonnet", "opus", "haiku"].contains(&cur.as_str()) {
                models.insert(
                    0,
                    json!({ "id": cur, "name": cur, "provider": "anthropic" }),
                );
            }
        }
        Ok(json!({ "models": models }))
    }

    pub async fn get_available_thinking_levels(&mut self) -> Result<Value, String> {
        Ok(json!({ "levels": ["low", "medium", "high", "xhigh", "max"] }))
    }

    pub async fn set_thinking_level(&mut self, level: String) -> Result<Value, String> {
        self.effort = level.clone();
        Ok(json!({ "level": level }))
    }

    pub async fn get_session_stats(&mut self) -> Result<Value, String> {
        Ok(json!({}))
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        kill_process_tree(&mut self.child).await;
        Ok(())
    }
}
