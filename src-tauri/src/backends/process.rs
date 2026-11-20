//! 跨平台 CLI 子进程辅助: 统一封装 Windows 抑窗 + 进程组隔离、系统代理继承、进程树清理、CLI 版本探测。
//!
//! 铁律 (.trellis/spec/backend/runtime-lifecycle.md):
//! 打包版 (GUI 子系统 exe, 无控制台) spawn 任何 console 子进程时, Windows 会为其分配
//! 新控制台并弹出黑窗。本模块统一在 Windows 上叠加 `CREATE_NO_WINDOW`, 避免后续新增
//! Agent 后端或探测命令漏设此标志。
//!
//! 系统代理铁律:
//! Windows GUI 应用直接启动时通常无 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量, 仅在 WinINet
//! 注册表启用了系统代理 (如 Clash/Mihomo 127.0.0.1:7890)。Go/Node CLI (`agy`/`claude`)
//! 默认只读环境变量不读 WinINet 注册表, 会导致直连超时。`build_cli_command` 在未显式
//! 设置代理环境变量时自动按当前系统代理补齐 (不覆盖用户已有环境变量, 并保底 `NO_PROXY`
//! 排除 `localhost,127.0.0.1,::1` 以免本地 language server/MCP 通信绕代理)。

use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct ParsedProxy {
    http: Option<String>,
    https: Option<String>,
}

/// 补齐代理 URL 的协议前缀 (Windows 注册表 `ProxyServer` 常省略 `http://`)。
fn normalize_proxy_url(raw: &str, default_scheme: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("://") {
        Some(trimmed.to_string())
    } else {
        Some(format!("{default_scheme}://{trimmed}"))
    }
}

/// 解析 Windows WinINet `ProxyServer` 注册表值:
/// - 单地址格式: `"127.0.0.1:7890"` 或 `"http://127.0.0.1:7890"` → 同时用于 http / https
/// - 分协议格式: `"http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891"`
fn parse_windows_proxy_server(raw: &str) -> ParsedProxy {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return ParsedProxy::default();
    }

    if !trimmed.contains('=') {
        let url = normalize_proxy_url(trimmed, "http");
        return ParsedProxy {
            http: url.clone(),
            https: url,
        };
    }

    let mut http = None;
    let mut https = None;
    let mut socks = None;
    for part in trimmed.split(';') {
        let Some((scheme, addr)) = part.split_once('=') else {
            continue;
        };
        match scheme.trim().to_ascii_lowercase().as_str() {
            "http" => http = normalize_proxy_url(addr, "http"),
            // Windows WinINet 里 `https=host:port` 指用于 HTTPS CONNECT 的 HTTP 代理, 默认 scheme 仍为 http
            "https" => https = normalize_proxy_url(addr, "http"),
            "socks" | "socks5" => socks = normalize_proxy_url(addr, "socks5"),
            _ => {}
        }
    }

    ParsedProxy {
        http: http.or_else(|| socks.clone()),
        https: https.or(socks),
    }
}

/// 将 Windows `ProxyOverride` 规整为标准 `NO_PROXY`:
/// 剔除 `<local>` 与含 `*` 的 Windows 私有通配项 (防止 Go/Node `httpproxy` 误判),
/// 始终保底包含 `localhost`, `127.0.0.1`, `::1`。
fn build_no_proxy(proxy_override: Option<&str>) -> String {
    let mut entries: Vec<String> = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];

    if let Some(raw) = proxy_override {
        for item in raw.split([';', ',']) {
            let s = item.trim();
            if s.is_empty()
                || s.eq_ignore_ascii_case("<local>")
                || s.contains('*')
                || s.contains('<')
                || s.contains('>')
            {
                continue;
            }
            if !entries.iter().any(|e| e.eq_ignore_ascii_case(s)) {
                entries.push(s.to_string());
            }
        }
    }

    entries.join(",")
}

/// 根据「进程现有环境变量」与「系统代理」计算需要补齐的 `(KEY, VALUE)` 列表。
/// 进程已显式设置任意大小写代理变量时绝不覆盖。
fn compute_proxy_env_patches<F>(
    proxy_server: Option<&str>,
    proxy_override: Option<&str>,
    get_env: F,
) -> Vec<(&'static str, String)>
where
    F: Fn(&str) -> Option<String>,
{
    let Some(server) = proxy_server else {
        return Vec::new();
    };
    let parsed = parse_windows_proxy_server(server);
    if parsed.http.is_none() && parsed.https.is_none() {
        return Vec::new();
    }

    let has_env = |upper: &str, lower: &str| {
        get_env(upper)
            .or_else(|| get_env(lower))
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    };

    let mut patches = Vec::new();
    if !has_env("HTTP_PROXY", "http_proxy") {
        if let Some(http) = parsed.http {
            patches.push(("HTTP_PROXY", http));
        }
    }
    if !has_env("HTTPS_PROXY", "https_proxy") {
        if let Some(https) = parsed.https {
            patches.push(("HTTPS_PROXY", https));
        }
    }
    if !patches.is_empty() && !has_env("NO_PROXY", "no_proxy") {
        patches.push(("NO_PROXY", build_no_proxy(proxy_override)));
    }
    patches
}

#[cfg(windows)]
fn read_windows_system_proxy() -> Option<(String, Option<String>)> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    let server = server.trim().to_string();
    if server.is_empty() {
        return None;
    }
    let override_list: Option<String> = key.get_value("ProxyOverride").ok();
    Some((server, override_list))
}

#[cfg(windows)]
fn apply_system_proxy_env(cmd: &mut Command) {
    let Some((server, override_list)) = read_windows_system_proxy() else {
        return;
    };
    let patches = compute_proxy_env_patches(
        Some(server.as_str()),
        override_list.as_deref(),
        |k| std::env::var(k).ok(),
    );
    for (k, v) in patches {
        cmd.env(k, v);
    }
}

/// 构造常驻 CLI 子进程命令 (用于 Agent sidecar)。
/// Windows 下经 `cmd /c <program> ...` 启动 (兼容 `.ps1` / `.cmd` / `.exe` shim),
/// 并同时设置 `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` 以便后续 `taskkill /T` 杀树且不弹黑窗,
/// 且在未显式配置代理环境变量时自动补齐 Windows 系统代理。
pub fn build_cli_command(program: &str, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg(program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        apply_system_proxy_env(&mut cmd);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_windows_proxy_server_formats() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890"),
            ParsedProxy {
                http: Some("http://127.0.0.1:7890".into()),
                https: Some("http://127.0.0.1:7890".into()),
            }
        );

        assert_eq!(
            parse_windows_proxy_server("http://127.0.0.1:7890"),
            ParsedProxy {
                http: Some("http://127.0.0.1:7890".into()),
                https: Some("http://127.0.0.1:7890".into()),
            }
        );

        assert_eq!(
            parse_windows_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891"),
            ParsedProxy {
                http: Some("http://127.0.0.1:7890".into()),
                https: Some("http://127.0.0.1:7891".into()),
            }
        );

        assert_eq!(
            parse_windows_proxy_server("socks=127.0.0.1:1080"),
            ParsedProxy {
                http: Some("socks5://127.0.0.1:1080".into()),
                https: Some("socks5://127.0.0.1:1080".into()),
            }
        );

        assert_eq!(parse_windows_proxy_server("  "), ParsedProxy::default());
    }

    #[test]
    fn builds_clean_no_proxy_with_loopback_defaults() {
        assert_eq!(build_no_proxy(None), "localhost,127.0.0.1,::1");
        assert_eq!(
            build_no_proxy(Some(
                "*zhihu.com;100ime-iat-api.xfyun.cn;localhost;*.local;127.*;127.0.0.1;<local>"
            )),
            "localhost,127.0.0.1,::1,100ime-iat-api.xfyun.cn"
        );
    }

    #[test]
    fn proxy_patches_respect_existing_env_vars() {
        let none = |_: &str| None;
        let patches = compute_proxy_env_patches(Some("127.0.0.1:7890"), Some("<local>"), none);
        assert_eq!(
            patches,
            vec![
                ("HTTP_PROXY", "http://127.0.0.1:7890".into()),
                ("HTTPS_PROXY", "http://127.0.0.1:7890".into()),
                ("NO_PROXY", "localhost,127.0.0.1,::1".into()),
            ]
        );

        let has_https_lower = |k: &str| {
            if k == "https_proxy" {
                Some("http://10.0.0.1:8888".into())
            } else {
                None
            }
        };
        let patches = compute_proxy_env_patches(Some("127.0.0.1:7890"), None, has_https_lower);
        assert_eq!(
            patches,
            vec![
                ("HTTP_PROXY", "http://127.0.0.1:7890".into()),
                ("NO_PROXY", "localhost,127.0.0.1,::1".into()),
            ]
        );

        let has_both = |k: &str| match k {
            "HTTP_PROXY" | "HTTPS_PROXY" => Some("http://existing:1234".into()),
            _ => None,
        };
        assert!(compute_proxy_env_patches(Some("127.0.0.1:7890"), None, has_both).is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "实机验证: 清空代理环境变量后依赖 Windows 系统代理完成 agy acp 握手"]
    async fn agy_acp_handshake_inherits_windows_system_proxy() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        // 模拟双击桌面 GUI 启动: 进程内无任何代理环境变量
        for k in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        ] {
            std::env::remove_var(k);
        }

        let program = std::env::var("USERPROFILE")
            .map(|h| format!(r"{h}\AppData\Local\agy\bin\agy.exe"))
            .unwrap_or_else(|_| "agy".to_string());
        let mut cmd = build_cli_command(&program, &["acp"]);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().expect("spawn agy acp");
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());

        let init = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "test", "version": "0.0.0" }
            }
        });
        stdin.write_all(format!("{init}\n").as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();

        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(10), stdout.read_line(&mut line))
            .await
            .expect("initialize timeout")
            .unwrap();
        let init_resp: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(init_resp["id"], 1);

        let cwd = std::env::current_dir().unwrap().to_string_lossy().to_string();
        let new_sess = serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "session/new",
            "params": { "cwd": cwd, "mcpServers": [] }
        });
        stdin.write_all(format!("{new_sess}\n").as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();

        line.clear();
        tokio::time::timeout(Duration::from_secs(20), stdout.read_line(&mut line))
            .await
            .expect("session/new timeout")
            .unwrap();
        let sess_resp: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(sess_resp["id"], 2);
        assert!(
            sess_resp["result"]["sessionId"]
                .as_str()
                .map(|s| !s.is_empty())
                .unwrap_or(false),
            "expected non-empty sessionId, got: {sess_resp}"
        );

        kill_process_tree(&mut child).await;
    }
}
