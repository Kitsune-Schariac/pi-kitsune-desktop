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
    /// 事件流绑定的 sessionId: 可变, warm runtime 复用时 rebind 到真实会话
    /// (预热时是 warm_xxx, 不复用则始终等于 spawn 传入值; 前端按此路由事件)
    session_id: Arc<Mutex<String>>,
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
        // sessionId 用 Arc<Mutex> 而非字符串值: warm runtime 被新会话复用时, 事件流必须能
        // 改绑到真实会话 id, 否则前端按 sessionId 查不到 → 流式事件全部丢失
        let sid = Arc::new(Mutex::new(session_id));
        let sid_for_reader = sid.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::with_capacity(8192);
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => {
                        let sid = sid_for_reader.lock().await;
                        let _ = app.emit("pi_event", serde_json::json!({
                            "sessionId": sid.as_str(),
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
                                // event 或无 id response → emit pi_event (sessionId 读当前绑定值)
                                let sid = sid_for_reader.lock().await;
                                let _ = app.emit("pi_event", serde_json::json!({
                                    "sessionId": sid.as_str(),
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
            session_id: sid,
            child,
            stdin,
            pending,
            id_counter: Arc::new(AtomicU64::new(0)),
        })
    }

    /// warm runtime 被新会话复用时, 把事件流 sessionId 改绑到真实会话
    /// (reader 每次 emit 前读当前值, 改绑对已在进行中的流式输出同样生效)
    pub async fn rebind_session(&self, new_session_id: String) {
        *self.session_id.lock().await = new_session_id;
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

    pub async fn send_prompt(
        &mut self,
        message: String,
        images: Option<Vec<serde_json::Value>>,
    ) -> Result<(), String> {
        let mut cmd = serde_json::json!({ "type": "prompt", "message": message });
        if let Some(imgs) = images {
            cmd["images"] = serde_json::Value::Array(imgs);
        }
        self.send_command(cmd).await
    }

    pub async fn abort(&mut self) -> Result<(), String> {
        self.send_command(serde_json::json!({ "type": "abort" })).await
    }

    /// steer: agent 运行中排队指导消息 (当前 turn 工具执行完后、下次 LLM 调用前投递)
    /// fire-and-forget: 投递与否由 queue_update 事件回推, 前端不依赖同步确认
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

    /// follow_up: agent 完全停止后排队的后续消息 (无更多工具调用或 steer 时投递)
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

    /// extension_ui_response 帧写回 pi stdin (fire-and-forget: pi 按 id 匹配 pending
    /// 扩展请求后自行 resolve, 不会回 response 帧, 所以不能走 send_request 通道)
    /// payload 由前端拼好 (confirmed/value/cancelled), 这里只补 type+id 标识
    pub async fn send_extension_ui_response(&mut self, id: String, payload: serde_json::Value) -> Result<(), String> {
        let mut frame = payload;
        if let Some(obj) = frame.as_object_mut() {
            obj.insert("type".into(), serde_json::json!("extension_ui_response"));
            obj.insert("id".into(), serde_json::json!(id));
        }
        self.send_command(frame).await
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

    // --- M4: 会话切换 / 历史 / 统计 / 重命名 ---

    /// 切换加载历史 session 文件; Ok(true) = 被扩展取消
    pub async fn switch_session(&mut self, session_path: String) -> Result<bool, String> {
        let data = Self::extract_data(
            self.send_request(serde_json::json!({ "type": "switch_session", "sessionPath": session_path }))
                .await?,
        )?;
        Ok(data.get("cancelled").and_then(|v| v.as_bool()).unwrap_or(false))
    }

    /// 拉取会话全量历史条目 (append 序, 含压缩前历史与分支)
    pub async fn get_entries(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "get_entries" })).await?)
    }

    /// token/成本/context window 统计 (全 session 累计)
    pub async fn get_session_stats(&mut self) -> Result<serde_json::Value, String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "get_session_stats" })).await?)
    }

    /// 设置会话显示名 (写入 session jsonl, pi 原生支持)
    pub async fn set_session_name(&mut self, name: String) -> Result<(), String> {
        Self::extract_data(self.send_request(serde_json::json!({ "type": "set_session_name", "name": name })).await?)?;
        Ok(())
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