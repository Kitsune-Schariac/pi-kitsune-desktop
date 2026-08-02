use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

/// 一个 `pi --mode rpc` 子进程的封装: 持有 stdin 写入端 + 子进程句柄
pub struct PiRuntime {
    #[allow(dead_code)] // M3 RuntimePool 会读取
    pub session_id: String,
    child: Child,
    stdin: ChildStdin,
}

impl PiRuntime {
    /// 启动 pi sidecar: spawn `pi --mode rpc`, 后台读 stdout 按 \n 切帧转发事件给前端
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

        // 后台 task: 按 \n 切帧读 stdout → 解析 JSON → emit 给前端
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
                            Ok(event) => {
                                let _ = app.emit("pi_event", serde_json::json!({
                                    "sessionId": &sid,
                                    "event": event,
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

        Ok(PiRuntime { session_id, child, stdin })
    }

    /// 写一个 RPC 命令到 pi stdin (JSON 序列化 + \n)
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

    pub async fn send_prompt(&mut self, message: String) -> Result<(), String> {
        self.send_command(serde_json::json!({ "type": "prompt", "message": message }))
            .await
    }

    pub async fn abort(&mut self) -> Result<(), String> {
        self.send_command(serde_json::json!({ "type": "abort" })).await
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