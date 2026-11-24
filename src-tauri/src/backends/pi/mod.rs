//! Pi CLI 后端驱动 (`pi --mode rpc`) 与专属预热槽 (`PiWarmPool`)。
//!
//! 从原 `pi_runtime.rs` 迁移: stdout reader 不再直接透传 PI 私有 JSON,
//! 而是经 `translate::translate_pi_frame` 翻译为 `UnifiedEvent` 后发射 `agent_event`。

pub mod translate;

use crate::backends::plan::PlanTracker;
use crate::backends::process::{build_cli_command, kill_process_tree, strip_newline};
use crate::backends::prompt::build_pi_extension_ui_payload;
use crate::backends::{AgentKind, UnifiedEvent, UserPromptKind, UserPromptResponse};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

/// pi RPC 命令的待响应表: id → oneshot sender
type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>>;

/// PI 专属预热槽 (绕开 pi ~3.5s 冷启动; 其他 CLI 无需同机制, 不污染通用池)。
pub struct PiWarmPool {
    warm: Option<PiBackend>,
    warm_cwd: Option<String>,
    /// 预热 spawn 进行中 (防并发重复预热)
    warming: bool,
    /// 预热代次: 每次作废预热槽 (drop_warm) 递增, 飞行中的旧预热落地时凭代次自废
    warm_epoch: u64,
}

impl PiWarmPool {
    pub fn new() -> Self {
        Self {
            warm: None,
            warm_cwd: None,
            warming: false,
            warm_epoch: 0,
        }
    }

    /// 取预热 runtime: cwd 匹配才复用, 否则 None
    pub fn take_warm(&mut self, cwd: &str) -> Option<PiBackend> {
        if self.warm_cwd.as_deref() == Some(cwd) {
            self.warming = false;
            self.warm_cwd = None;
            self.warm.take()
        } else {
            None
        }
    }

    /// 丢弃预热槽并递增代次, 异步 stop 不阻塞调用方
    pub fn drop_warm(&mut self) {
        self.warm_epoch = self.warm_epoch.wrapping_add(1);
        if let Some(mut rt) = self.warm.take() {
            self.warm_cwd = None;
            tauri::async_runtime::spawn(async move {
                let _ = rt.stop().await;
            });
        }
        self.warming = false;
    }

    /// 标记预热进行中; 已有预热/就绪槽返回 None, 否则返回本轮代次
    pub fn mark_warming(&mut self) -> Option<u64> {
        if self.warming || self.warm.is_some() {
            None
        } else {
            self.warming = true;
            Some(self.warm_epoch)
        }
    }

    /// 预热完成回写; epoch 不符说明期间配置已改动, 直接停掉过期实例
    pub fn finish_warming(&mut self, cwd: String, epoch: u64, rt: Result<PiBackend, String>) {
        self.warming = false;
        if epoch != self.warm_epoch {
            if let Ok(mut stale) = rt {
                tauri::async_runtime::spawn(async move {
                    let _ = stale.stop().await;
                });
            }
            return;
        }
        if let Ok(rt) = rt {
            self.warm = Some(rt);
            self.warm_cwd = Some(cwd);
        }
    }

    /// 窗口关闭时同步清理预热槽
    pub async fn stop(&mut self) {
        if let Some(mut rt) = self.warm.take() {
            let _ = rt.stop().await;
        }
        self.warm_cwd = None;
        self.warming = false;
        self.warm_epoch = self.warm_epoch.wrapping_add(1);
    }
}

/// 一个 `pi --mode rpc` 子进程的封装
pub struct PiBackend {
    /// 事件流绑定的 sessionId: warm 复用时 rebind 到真实会话
    session_id: Arc<Mutex<String>>,
    child: Child,
    stdin: ChildStdin,
    pending: PendingRequests,
    /// 记录已下发的 extension_ui_request 原始交互类型, 供统一 respond_user_prompt 逆向编码
    pending_prompt_kinds: Arc<Mutex<HashMap<String, UserPromptKind>>>,
    id_counter: Arc<AtomicU64>,
}

impl PiBackend {
    /// 启动 pi sidecar: spawn `pi --mode rpc`, 后台读 stdout 分流 (response 走 pending, event 翻译后走 agent_event)
    pub async fn spawn(
        app: AppHandle,
        session_id: String,
        cwd: String,
        provider: Option<String>,
        model: Option<String>,
        cli_override: Option<String>,
    ) -> Result<Self, String> {
        let program = cli_override
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("pi");
        let mut cmd = build_cli_command(program, &["--mode", "rpc"]);
        if let Some(p) = provider.as_deref() {
            cmd.arg("--provider").arg(p);
        }
        if let Some(m) = model.as_deref() {
            cmd.arg("--model").arg(m);
        }
        cmd.current_dir(&cwd);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            format!("启动 pi 子进程失败: {e}。确认已 npm i -g @earendil-works/pi-coding-agent")
        })?;

        let stdin = child.stdin.take().ok_or("无法获取 pi stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取 pi stdout")?;
        let stderr = child.stderr.take();

        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();
        let pending_prompt_kinds: Arc<Mutex<HashMap<String, UserPromptKind>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let prompt_kinds_for_reader = pending_prompt_kinds.clone();

        // 严格按 \n 切帧读 stdout, 分流 response 与事件流
        let sid = Arc::new(Mutex::new(session_id));
        let sid_for_reader = sid.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::with_capacity(8192);
            let mut plan_tracker = PlanTracker::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => {
                        let sid = sid_for_reader.lock().await;
                        let ev = UnifiedEvent::ProcessExit {
                            agent_kind: AgentKind::Pi,
                            message: "pi 进程已退出".into(),
                        };
                        let _ = app.emit(
                            "agent_event",
                            serde_json::json!({
                                "sessionId": sid.as_str(),
                                "event": ev,
                            }),
                        );
                        break;
                    }
                    Ok(_) => {
                        let line = strip_newline(&buf);
                        if line.is_empty() {
                            continue;
                        }
                        match serde_json::from_slice::<serde_json::Value>(line) {
                            Ok(frame) => {
                                let is_response = frame.get("type").and_then(|v| v.as_str())
                                    == Some("response");
                                let id = frame
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                if is_response {
                                    if let Some(id) = id {
                                        let mut guard = pending_for_reader.lock().await;
                                        if let Some(sender) = guard.remove(&id) {
                                            let _ = sender.send(frame);
                                            continue;
                                        }
                                    }
                                }
                                let events = translate::translate_pi_frame(&frame);
                                if !events.is_empty() {
                                    let sid_str = sid_for_reader.lock().await.clone();
                                    for ev in events {
                                        if let UnifiedEvent::UserPrompt { ref request } = ev {
                                            prompt_kinds_for_reader
                                                .lock()
                                                .await
                                                .insert(request.id.clone(), request.kind);
                                        }
                                        let extra_plan = match &ev {
                                            UnifiedEvent::ToolStart {
                                                tool_call_id,
                                                tool_name,
                                                args,
                                            } => plan_tracker.ingest_tool_start(
                                                tool_call_id,
                                                tool_name,
                                                args,
                                            ),
                                            UnifiedEvent::ToolEnd {
                                                tool_call_id,
                                                result,
                                                ..
                                            } => plan_tracker.ingest_tool_end(tool_call_id, result),
                                            _ => None,
                                        };
                                        let _ = app.emit(
                                            "agent_event",
                                            serde_json::json!({
                                                "sessionId": sid_str.as_str(),
                                                "event": ev,
                                            }),
                                        );
                                        if let Some(plan) = extra_plan {
                                            let _ = app.emit(
                                                "agent_event",
                                                serde_json::json!({
                                                    "sessionId": sid_str.as_str(),
                                                    "event": UnifiedEvent::PlanUpdate { plan },
                                                }),
                                            );
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("[pi_backend] JSON 解析失败: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[pi_backend] 读 stdout 出错: {e}");
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
                            eprintln!("[pi stderr] {}", s.trim_end());
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        Ok(PiBackend {
            session_id: sid,
            child,
            stdin,
            pending,
            pending_prompt_kinds,
            id_counter: Arc::new(AtomicU64::new(0)),
        })
    }

    /// warm runtime 被新会话复用时, 把事件流 sessionId 改绑到真实会话
    pub async fn rebind_session(&self, new_session_id: String) {
        *self.session_id.lock().await = new_session_id;
    }

    async fn send_command(&mut self, command: serde_json::Value) -> Result<(), String> {
        let line = serde_json::to_string(&command).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("写 pi stdin 失败: {e}"))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("写换行失败: {e}"))?;
        Ok(())
    }

    async fn send_request(
        &mut self,
        command: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.send_request_timeout(command, 30).await
    }

    async fn send_request_timeout(
        &mut self,
        command: serde_json::Value,
        timeout_secs: u64,
    ) -> Result<serde_json::Value, String> {
        let id = format!("req-{}", self.id_counter.fetch_add(1, Ordering::SeqCst));
        let mut cmd = command;
        if let Some(obj) = cmd.as_object_mut() {
            obj.insert("id".into(), serde_json::json!(id));
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("写 pi stdin 失败: {e}"))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("写换行失败: {e}"))?;

        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                Err("pi 响应通道关闭".into())
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("等待 pi 响应超时 ({timeout_secs}s)"))
            }
        }
    }

    fn extract_data(resp: serde_json::Value) -> Result<serde_json::Value, String> {
        if resp.get("success").and_then(|v| v.as_bool()) == Some(true) {
            Ok(resp.get("data").cloned().unwrap_or(serde_json::Value::Null))
        } else {
            Err(resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("未知错误")
                .to_string())
        }
    }

    pub async fn send_prompt(
        &mut self,
        message: String,
        images: Option<Vec<serde_json::Value>>,
    ) -> Result<serde_json::Value, String> {
        let mut cmd = serde_json::json!({ "type": "prompt", "message": message });
        if let Some(imgs) = images {
            cmd["images"] = serde_json::Value::Array(imgs);
        }
        Self::extract_data(self.send_request(cmd).await?)
    }

    pub async fn abort(&mut self) -> Result<(), String> {
        match self
            .send_request_timeout(serde_json::json!({ "type": "abort" }), 8)
            .await
        {
            Ok(resp) => Self::extract_data(resp).map(|_| ()),
            Err(e) if e.starts_with("等待 pi 响应超时") => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub async fn steer(
        &mut self,
        message: String,
        images: Option<Vec<serde_json::Value>>,
    ) -> Result<(), String> {
        let mut cmd = serde_json::json!({ "type": "steer", "message": message });
        if let Some(imgs) = images {
            cmd["images"] = serde_json::Value::Array(imgs);
        }
        self.send_command(cmd).await
    }

    pub async fn follow_up(
        &mut self,
        message: String,
        images: Option<Vec<serde_json::Value>>,
    ) -> Result<(), String> {
        let mut cmd = serde_json::json!({ "type": "follow_up", "message": message });
        if let Some(imgs) = images {
            cmd["images"] = serde_json::Value::Array(imgs);
        }
        self.send_command(cmd).await
    }

    pub async fn send_extension_ui_response(
        &mut self,
        id: String,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        let mut frame = payload;
        if let Some(obj) = frame.as_object_mut() {
            obj.insert("type".into(), serde_json::json!("extension_ui_response"));
            obj.insert("id".into(), serde_json::json!(id));
        }
        self.send_command(frame).await
    }

    pub async fn respond_user_prompt(
        &mut self,
        request_id: String,
        response: UserPromptResponse,
    ) -> Result<(), String> {
        let kind = self
            .pending_prompt_kinds
            .lock()
            .await
            .remove(&request_id)
            .unwrap_or(UserPromptKind::Input);
        let payload = build_pi_extension_ui_payload(kind, response);
        self.send_extension_ui_response(request_id, payload).await
    }

    pub async fn get_state(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "get_state" })).await?)
    }

    pub async fn get_available_models(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(
            self.send_request(serde_json::json!({ "type": "get_available_models" }))
                .await?,
        )
    }

    pub async fn set_model(
        &mut self,
        provider: String,
        model_id: String,
    ) -> Result<serde_json::Value, String> {
        Self::extract_data(
            self.send_request(serde_json::json!({
                "type": "set_model",
                "provider": provider,
                "modelId": model_id
            }))
            .await?,
        )
    }

    pub async fn cycle_model(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(
            self.send_request(serde_json::json!({ "type": "cycle_model" }))
                .await?,
        )
    }

    pub async fn set_thinking_level(&mut self, level: String) -> Result<serde_json::Value, String> {
        Self::extract_data(
            self.send_request(serde_json::json!({ "type": "set_thinking_level", "level": level }))
                .await?,
        )
    }

    pub async fn cycle_thinking_level(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(
            self.send_request(serde_json::json!({ "type": "cycle_thinking_level" }))
                .await?,
        )
    }

    pub async fn get_available_thinking_levels(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(
            self.send_request(serde_json::json!({ "type": "get_available_thinking_levels" }))
                .await?,
        )
    }

    pub async fn switch_session(&mut self, session_path: String) -> Result<bool, String> {
        let data = Self::extract_data(
            self.send_request(serde_json::json!({
                "type": "switch_session",
                "sessionPath": session_path
            }))
            .await?,
        )?;
        Ok(data
            .get("cancelled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false))
    }

    pub async fn get_entries(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(
            self.send_request(serde_json::json!({ "type": "get_entries" }))
                .await?,
        )
    }

    pub async fn get_session_stats(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(
            self.send_request(serde_json::json!({ "type": "get_session_stats" }))
                .await?,
        )
    }

    pub async fn set_session_name(&mut self, name: String) -> Result<(), String> {
        Self::extract_data(
            self.send_request(serde_json::json!({ "type": "set_session_name", "name": name }))
                .await?,
        )?;
        Ok(())
    }

    pub async fn get_commands(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(
            self.send_request(serde_json::json!({ "type": "get_commands" }))
                .await?,
        )
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        kill_process_tree(&mut self.child).await;
        Ok(())
    }
}
