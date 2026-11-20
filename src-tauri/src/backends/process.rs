//! 跨平台 CLI 子进程辅助: 统一封装 Windows 抑窗 + 进程组隔离、进程树清理、CLI 版本探测。
//!
//! 铁律 (.trellis/spec/backend/runtime-lifecycle.md):
//! 打包版 (GUI 子系统 exe, 无控制台) spawn 任何 console 子进程时, Windows 会为其分配
//! 新控制台并弹出黑窗。本模块统一在 Windows 上叠加 `CREATE_NO_WINDOW`, 避免后续新增
//! Agent 后端或探测命令漏设此标志。

use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 构造常驻 CLI 子进程命令 (用于 Agent sidecar)。
/// Windows 下经 `cmd /c <program> ...` 启动 (兼容 `.ps1` / `.cmd` / `.exe` shim),
/// 并同时设置 `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` 以便后续 `taskkill /T` 杀树且不弹黑窗。
pub fn build_cli_command(program: &str, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg(program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd
    }
}

/// 强制终止子进程及其派生进程树 (Windows 用 `taskkill /PID /T /F` 并抑窗)。
pub async fn kill_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .await;
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill().await;
    }
}

/// 异步探测本机 CLI 是否可用并返回首行版本串 (超时或退出码非 0 返回 `None`)。
pub async fn probe_cli_version(program: &str, args: &[&str], timeout_secs: u64) -> Option<String> {
    let mut cmd = build_cli_command(program, args);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .ok()?
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let raw = if !stdout.trim().is_empty() {
        stdout.as_ref()
    } else {
        stderr.as_ref()
    };

    raw.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

/// 去掉尾部的 `\n` 和可选 `\r` (JSONL 分帧规则: 严格按 `\n` 切帧, 不处理 U+2028/U+2029)。
pub fn strip_newline(buf: &[u8]) -> &[u8] {
    let mut end = buf.len();
    if end > 0 && buf[end - 1] == b'\n' {
        end -= 1;
    }
    if end > 0 && buf[end - 1] == b'\r' {
        end -= 1;
    }
    &buf[..end]
}
