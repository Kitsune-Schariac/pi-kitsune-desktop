use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

/// pi RPC 命令的待响应表: id → oneshot sender
/// 发命令时生成 id 存入, stdout reader 收到对应 response 后取出唤醒, 实现 request-response 关联
type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>>;

/// 一个 `pi --mode rpc` 子进程的封装
pub struct PiRuntime {
    #[allow(dead_code)] // M3 RuntimePool 会读取
    pub session_id: String,
    child: Child,
    stdin: ChildStdin,
    pending: PendingRequests,
    id_counter: Arc<AtomicU64>,
}

impl PiRuntime {
    /// 启动 pi sidecar: spawn `pi --mode rpc`, 后台读 stdout 分流 (response 走 pending, event 走 pi_event)
    pub async fn spawn(
        app: AppHandle,
        session_id: String,
        cwd: String,
        provider: Option<String>,
        model: Option<String>,
    ) -> Result<Self, String> {
        let mut cmd = build_pi_command();
        cmd.arg("--mode").arg("rpc");
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

        // 后台 task: 按 \n 切帧读 stdout, 分流 response 和 event
        // 铁律: 严格按 \n 切, 不用会处理 U+2028/U+2029 的通用 line reader (Node readline 的坑, 这俩在 JSON 字符串里合法)
        let sid = session_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::with_capacity(8192);
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => {
                        let _ = app.emit("pi_event", serde_json::json!({
                            "sessionId": &sid,
                            "event": { "type": "pi_process_exit" }
                        }));
                        break;
                    }
                    Ok(_) => {
                        let line = strip_newline(&buf);
                        if line.is_empty() {
                            continue;
                        }
                        match serde_json::from_slice::<serde_json::Value>(line) {
                            Ok(frame) => {
                                // 分流: type="response" 且带 id 的帧 → 走 pending channel 交给 send_request
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
                                    // 没匹配到 pending 的 response fallthrough 走事件流 (过期/无 id)
                                }
                                // event 或无 id response → emit pi_event
                                let _ = app.emit("pi_event", serde_json::json!({
                                    "sessionId": &sid,
                                    "event": frame,
                                }));
                            }
                            Err(e) => {
                                eprintln!("[pi_runtime] JSON 解析失败: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[pi_runtime] 读 stdout 出错: {e}");
                        break;
                    }
                }
            }
        });

        // 后台 task: stderr 输出到控制台 (调试用)
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

        Ok(PiRuntime {
            session_id,
            child,
            stdin,
            pending,
            id_counter: Arc::new(AtomicU64::new(0)),
        })
    }

    /// fire-and-forget: 写命令到 pi stdin (JSON + \n), 不等响应 (prompt/abort 用, 真正回复走事件流)
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

    /// request-response: 发带 id 的命令, 注册 oneshot, 等 stdout reader 按 id 回送 response
    async fn send_request(
        &mut self,
        command: serde_json::Value,
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

        // 30s 超时防 pi 不响应; 超时/错误后清理 pending 表防泄漏
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                Err("pi 响应通道关闭".into())
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("等待 pi 响应超时 (30s)".into())
            }
        }
    }

    /// 从 response 里取 data, 失败取 error
    fn extract_data(resp: serde_json::Value) -> Result<serde_json::Value, String> {
        if resp.get("success").and_then(|v| v.as_bool()) == Some(true) {
            Ok(resp.get("data").cloned().unwrap_or(serde_json::Value::Null))
        } else {
            Err(resp.get("error").and_then(|v| v.as_str()).unwrap_or("未知错误").to_string())
        }
    }

    // --- fire-and-forget 命令 (回复走事件流) ---

    pub async fn send_prompt(&mut self, message: String) -> Result<(), String> {
        self.send_command(serde_json::json!({ "type": "prompt", "message": message }))
            .await
    }

    pub async fn abort(&mut self) -> Result<(), String> {
        self.send_command(serde_json::json!({ "type": "abort" })).await
    }

    // --- request-response 命令 (同步返回 data) ---

    pub async fn get_state(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "get_state" })).await?)
    }

    pub async fn get_available_models(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "get_available_models" })).await?)
    }

    pub async fn set_model(&mut self, provider: String, model_id: String) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "set_model", "provider": provider, "modelId": model_id })).await?)
    }

    pub async fn cycle_model(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "cycle_model" })).await?)
    }

    pub async fn set_thinking_level(&mut self, level: String) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "set_thinking_level", "level": level })).await?)
    }

    pub async fn cycle_thinking_level(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "cycle_thinking_level" })).await?)
    }

    pub async fn get_available_thinking_levels(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "get_available_thinking_levels" })).await?)
    }

    /// 停止 pi 子进程; Windows 上 taskkill /T 杀整个进程树 (cmd /c 派生的 node 进程也要带走)
    pub async fn stop(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if let Some(pid) = self.child.id() {
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .output()
                    .await;
            }
        }
        #[cfg(not(windows))]
        {
            let _ = self.child.kill().await;
        }
        Ok(())
    }
}

#[cfg(windows)]
fn build_pi_command() -> Command {
    let mut cmd = Command::new("cmd");
    cmd.arg("/c").arg("pi");
    // CREATE_NEW_PROCESS_GROUP: 隔离进程组, 便于后续 taskkill /T 管理整棵进程树
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    cmd
}

#[cfg(not(windows))]
fn build_pi_command() -> Command {
    Command::new("pi")
}

/// 去掉尾部的 \n 和可选 \r (符合 pi RPC 的 JSONL 分帧规则: 接受 \r\n, strip 尾部 \r)
fn strip_newline(buf: &[u8]) -> &[u8] {
    let mut end = buf.len();
    if end > 0 && buf[end - 1] == b'\n' {
        end -= 1;
    }
    if end > 0 && buf[end - 1] == b'\r' {
        end -= 1;
    }
    &buf[..end]
}