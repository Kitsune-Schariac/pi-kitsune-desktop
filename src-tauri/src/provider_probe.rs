//! 设置窗「测试连接 / 拉取模型列表」: 用面板里**编辑中**的 provider 配置请求 `{baseUrl}/models`。
//!
//! ## 为什么放 Rust 而不是前端 fetch
//! WebView 里 fetch 第三方域名受 CORS 限制 (中转站多半不带 CORS 头), 也拿不到 pi 的代理规则。
//! 这里与 pi 走同一套密钥解析、同一套代理规则, 否则会出现「面板测得通、会话用不了」的假结论。
//!
//! ## 只做 OpenAI 兼容接口
//! 老大 2026-09-30 决定。其余接口类型与 `!command` 取值的密钥 / header 返回「暂不支持」,
//! 不发请求 (命令取值每次都会真实执行一条 shell 命令, 测试按钮不该有这种副作用)。
//!
//! ## 预期内的失败走 Ok
//! 地址非法、密钥缺失、HTTP 非 2xx、超时等都是「测试结果」, 返回 `Ok(ProbeResult { ok: false })`,
//! 前端据 `error_kind` 给修复建议; `Err` 只留给 HTTP 客户端构建失败这类内部错误。
//!
//! ## 安全
//! 解析后的密钥与 header 值不进日志、错误信息、返回值; 响应体片段在截断前把密钥子串替换成 `***`。

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};

const OPENAI_COMPAT_APIS: [&str; 4] = [
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "mistral-conversations",
];

#[derive(Serialize, Debug)]
pub struct ProbeResult {
    pub ok: bool,
    /// 实际请求的 URL (密钥只在请求头里, URL 不含密钥); 没拼出合法 URL 时为原始 baseUrl
    pub url: String,
    /// HTTP 状态码; 请求没发出去或没收到响应时为 None
    pub status: Option<u16>,
    pub elapsed_ms: u64,
    /// 去重 + 排序后的模型 id
    pub models: Vec<String>,
    /// unsupported_api / invalid_url / no_key / unsupported_key / invalid_header / http / timeout / connect / parse
    pub error_kind: Option<String>,
    /// 面向用户的中文说明; 成功时也可能有 (如「接口类型未设置」提示)
    pub message: Option<String>,
}

#[tauri::command]
pub async fn probe_provider_models(provider: Value) -> Result<ProbeResult, String> {
    probe(&provider, read_settings_proxy().as_deref(), &|name| std::env::var(name).ok()).await
}

/// 探测主流程。`env` 注入环境变量读取, 单测不用改进程环境
async fn probe(
    provider: &Value,
    settings_proxy: Option<&str>,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<ProbeResult, String> {
    let Some(pobj) = provider.as_object() else {
        return Err("provider 配置必须是对象".into());
    };
    let raw_base = pobj.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();

    // api 未设置时 pi 允许在模型级各自指定; 本面板按 OpenAI 兼容方式尝试并注明, 不代表 pi 默认
    let mut note: Option<String> = None;
    match pobj.get("api") {
        None => note = Some("接口类型未设置, 按 OpenAI 兼容方式测试".into()),
        Some(Value::String(api)) if OPENAI_COMPAT_APIS.contains(&api.as_str()) => {}
        Some(other) => {
            let shown = other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string());
            return Ok(fail(&raw_base, "unsupported_api", format!("接口类型 {shown} 暂不支持测试, 目前只支持 OpenAI 兼容接口")));
        }
    }

    let url = match build_models_url(&raw_base) {
        Ok(u) => u,
        Err(msg) => return Ok(fail(&raw_base, "invalid_url", msg)),
    };

    let key = match pobj.get("apiKey").and_then(|v| v.as_str()).map(str::trim) {
        None | Some("") => return Ok(fail(&url, "no_key", "未配置密钥 (apiKey)".into())),
        Some(raw) => match resolve_config_value(raw, env) {
            Resolved::Command => {
                return Ok(fail(&url, "unsupported_key", "密钥使用 !命令 取值, 暂不支持测试".into()))
            }
            Resolved::MissingEnv(names) => {
                return Ok(fail(&url, "no_key", format!("密钥引用的环境变量 {} 未设置或为空", names.join(", "))))
            }
            Resolved::Value(v) if v.is_empty() => return Ok(fail(&url, "no_key", "密钥解析后为空".into())),
            Resolved::Value(v) => v,
        },
    };

    // 头的合并顺序对齐 pi: 先 Bearer (OpenAI SDK 默认行为; authHeader: true 在 pi 里加的也是
    // 这同一个头, 所以两者结果一致), 再用 provider.headers 逐个覆盖同名头
    let mut headers = HeaderMap::new();
    match HeaderValue::from_str(&format!("Bearer {key}")) {
        Ok(mut hv) => {
            hv.set_sensitive(true);
            headers.insert(AUTHORIZATION, hv);
        }
        Err(_) => return Ok(fail(&url, "invalid_header", "密钥含有不能放进请求头的字符 (如换行)".into())),
    }
    if let Some(hobj) = pobj.get("headers").and_then(|h| h.as_object()) {
        for (name, raw) in hobj {
            let Some(raw) = raw.as_str() else {
                return Ok(fail(&url, "invalid_header", format!("header {name} 的值必须是字符串")));
            };
            let value = match resolve_config_value(raw, env) {
                Resolved::Command => {
                    return Ok(fail(&url, "unsupported_key", format!("header {name} 使用 !命令 取值, 暂不支持测试")))
                }
                Resolved::MissingEnv(names) => {
                    return Ok(fail(&url, "no_key", format!("header {name} 引用的环境变量 {} 未设置或为空", names.join(", "))))
                }
                Resolved::Value(v) => v,
            };
            let (Ok(hn), Ok(mut hv)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(&value)) else {
                return Ok(fail(&url, "invalid_header", format!("header {name} 的名称或值含非法字符")));
            };
            hv.set_sensitive(true);
            headers.insert(hn, hv);
        }
    }

    // 关掉 reqwest 的自动代理, 按 pi 的规则显式装配 (见 proxy_plan)
    let plan = proxy_plan(settings_proxy, env);
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .no_proxy();
    for (target, proxy_url) in [("http", plan.http), ("https", plan.https)] {
        let Some(proxy_url) = proxy_url else { continue };
        let proxy = if target == "http" { reqwest::Proxy::http(&proxy_url) } else { reqwest::Proxy::https(&proxy_url) };
        match proxy {
            Ok(p) => builder = builder.proxy(p.no_proxy(reqwest::NoProxy::from_env())),
            Err(e) => return Ok(fail(&url, "connect", format!("代理地址非法 ({proxy_url}): {e}"))),
        }
    }
    let client = builder.build().map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let started = Instant::now();
    let resp = client.get(&url).headers(headers).send().await;
    let (status, body) = match resp {
        Ok(r) => {
            let status = r.status();
            match r.text().await {
                Ok(body) => (status, body),
                Err(e) => return Ok(network_fail(&url, started, Some(status.as_u16()), &e, &key)),
            }
        }
        Err(e) => return Ok(network_fail(&url, started, None, &e, &key)),
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;

    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or("");
        let snippet = snippet_of(&body, &key);
        let message = if snippet.is_empty() {
            format!("HTTP {} {reason}", status.as_u16())
        } else {
            format!("HTTP {} {reason}: {snippet}", status.as_u16())
        };
        return Ok(ProbeResult {
            ok: false,
            url,
            status: Some(status.as_u16()),
            elapsed_ms,
            models: Vec::new(),
            error_kind: Some("http".into()),
            message: Some(message),
        });
    }
    match parse_model_list(&body) {
        Some(models) => Ok(ProbeResult {
            ok: true,
            url,
            status: Some(status.as_u16()),
            elapsed_ms,
            models,
            error_kind: None,
            message: note,
        }),
        None => Ok(ProbeResult {
            ok: false,
            url,
            status: Some(status.as_u16()),
            elapsed_ms,
            models: Vec::new(),
            error_kind: Some("parse".into()),
            message: Some(format!("响应不是可识别的模型列表: {}", snippet_of(&body, &key))),
        }),
    }
}

fn fail(url: &str, kind: &str, message: String) -> ProbeResult {
    ProbeResult {
        ok: false,
        url: url.to_string(),
        status: None,
        elapsed_ms: 0,
        models: Vec::new(),
        error_kind: Some(kind.into()),
        message: Some(message),
    }
}

/// reqwest 顶层错误只有「error sending request」, 中间层是 hyper 的「client error (Connect)」这类
/// 包装, 真正原因 (连接被拒 / DNS / 证书) 在 source 链的最底层, 只取它
fn network_fail(url: &str, started: Instant, status: Option<u16>, e: &reqwest::Error, key: &str) -> ProbeResult {
    let mut root = e.to_string();
    let mut cur: Option<&dyn std::error::Error> = std::error::Error::source(e);
    while let Some(err) = cur {
        root = err.to_string();
        cur = err.source();
    }
    let detail = root;
    let (kind, message) = if e.is_timeout() {
        ("timeout", "请求超时 (连接 8s / 总计 15s)".to_string())
    } else {
        ("connect", format!("连接失败: {}", detail.replace(key, "***")))
    };
    ProbeResult {
        ok: false,
        url: url.to_string(),
        status,
        elapsed_ms: started.elapsed().as_millis() as u64,
        models: Vec::new(),
        error_kind: Some(kind.into()),
        message: Some(message),
    }
}

/// 响应体片段: 先脱敏再按字符截断 (先截断的话, 密钥被截成两半就替换不掉了)
fn snippet_of(body: &str, key: &str) -> String {
    let redacted = if key.is_empty() { body.to_string() } else { body.replace(key, "***") };
    let flat = redacted.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(200).collect();
    if flat.chars().count() > 200 {
        out.push('…');
    }
    out
}

/// `{baseUrl 去尾斜杠}/models`; 只接受带主机名的 http / https 地址
fn build_models_url(base: &str) -> Result<String, String> {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("未填写地址 (baseUrl)".into());
    }
    // 最常见的写法错误是漏了协议头, url 库对它只报「relative URL without a base」, 这里先拦下说人话
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("地址必须以 http:// 或 https:// 开头".into());
    }
    let url = format!("{trimmed}/models");
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("地址无法解析: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("地址必须以 http:// 或 https:// 开头".into());
    }
    if parsed.host_str().map_or(true, str::is_empty) {
        return Err("地址缺少主机名".into());
    }
    Ok(url)
}

/// 依次接受 `{ data: [...] }` (OpenAI 标准)、顶层数组、`{ models: [...] }`; 元素取 id,
/// 没有则取 name, 也接受直接是字符串的元素。数组非空却一个 id 都取不出 = 不是模型列表
fn parse_model_list(body: &str) -> Option<Vec<String>> {
    let v: Value = serde_json::from_str(body).ok()?;
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.as_array())
        .or_else(|| v.get("models").and_then(|m| m.as_array()))?;
    let mut ids: Vec<String> = arr
        .iter()
        .filter_map(|m| match m {
            Value::String(s) => Some(s.trim().to_string()),
            Value::Object(o) => o
                .get("id")
                .and_then(|x| x.as_str())
                .or_else(|| o.get("name").and_then(|x| x.as_str()))
                .map(|s| s.trim().to_string()),
            _ => None,
        })
        .filter(|s| !s.is_empty())
        .collect();
    if ids.is_empty() && !arr.is_empty() {
        return None;
    }
    ids.sort();
    ids.dedup();
    Some(ids)
}

#[derive(Debug, PartialEq)]
enum Resolved {
    Value(String),
    /// 前导 `!`: 命令取值, 不支持
    Command,
    /// 引用的环境变量缺失或为空 (pi 用 `||` 取值, 空串同样视为缺失)
    MissingEnv(Vec<String>),
}

/// 逐字对齐 pi resolve-config-value.js 的模板语义: 前导 `!` 为命令; 其余为模板 ——
/// `$$` → `$`, `$!` → `!`, `${NAME}` / `$NAME` 在串中任意位置插值, `${` 无闭合或名字非法时
/// 按字面保留, `$` 后不接变量名时是字面 `$`。任一变量缺失则整个值无效。
fn resolve_config_value(raw: &str, env: &(dyn Fn(&str) -> Option<String> + Sync)) -> Resolved {
    if raw.starts_with('!') {
        return Resolved::Command;
    }
    let mut out = String::new();
    let mut missing: Vec<String> = Vec::new();
    let mut lookup = |name: &str, out: &mut String| match env(name).filter(|v| !v.is_empty()) {
        Some(v) => out.push_str(&v),
        None => {
            if !missing.iter().any(|m| m == name) {
                missing.push(name.to_string());
            }
        }
    };
    let mut rest = raw;
    while let Some(i) = rest.find('$') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.chars().next() {
            Some(c @ ('$' | '!')) => {
                out.push(c);
                rest = &after[1..];
            }
            Some('{') => match after[1..].find('}') {
                None => {
                    out.push('$');
                    rest = after;
                }
                Some(end) => {
                    let name = &after[1..1 + end];
                    if env_name_prefix_len(name) == name.len() && !name.is_empty() {
                        lookup(name, &mut out);
                    } else {
                        out.push_str("${");
                        out.push_str(name);
                        out.push('}');
                    }
                    rest = &after[end + 2..];
                }
            },
            _ => {
                let n = env_name_prefix_len(after);
                if n > 0 {
                    lookup(&after[..n], &mut out);
                    rest = &after[n..];
                } else {
                    out.push('$');
                    rest = after;
                }
            }
        }
    }
    out.push_str(rest);
    if missing.is_empty() {
        Resolved::Value(out)
    } else {
        Resolved::MissingEnv(missing)
    }
}

/// `[A-Za-z_][A-Za-z0-9_]*` 前缀长度 (全 ASCII, 字节长度即字符长度)
fn env_name_prefix_len(s: &str) -> usize {
    let bytes = s.as_bytes();
    if bytes.first().map_or(true, |b| !(b.is_ascii_alphabetic() || *b == b'_')) {
        return 0;
    }
    bytes.iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'_').count()
}

#[derive(Debug, PartialEq)]
struct ProxyPlan {
    http: Option<String>,
    https: Option<String>,
}

/// pi 的代理规则 (http-dispatcher.js): `HTTP_PROXY ??= httpProxy; HTTPS_PROXY ??= httpProxy`,
/// 再交给 undici EnvHttpProxyAgent (读 `http_proxy ?? HTTP_PROXY`, 遵守 NO_PROXY)。
/// 即**环境变量优先**, settings.json 的 httpProxy 只填补没设置的那一个。
fn proxy_plan(settings_proxy: Option<&str>, env: &(dyn Fn(&str) -> Option<String> + Sync)) -> ProxyPlan {
    let from_env = |lower: &str, upper: &str| {
        env(lower).or_else(|| env(upper)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    let fallback = settings_proxy.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    ProxyPlan {
        http: from_env("http_proxy", "HTTP_PROXY").or_else(|| fallback.clone()),
        https: from_env("https_proxy", "HTTPS_PROXY").or(fallback),
    }
}

/// 每次探测现读 settings.json 的 httpProxy (面板打开期间 pi 可能改过); 读不到按未设置处理
fn read_settings_proxy() -> Option<String> {
    let path = crate::session_fs::agent_dir().ok()?.join("settings.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    v.get("httpProxy")?.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + Sync {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn resolves_values_like_pi() {
        let env = env_of(&[("KEY", "sk-1"), ("EMPTY", ""), ("B", "bb")]);
        let r = |s: &str| resolve_config_value(s, &env);
        assert_eq!(r("sk-literal"), Resolved::Value("sk-literal".into()));
        assert_eq!(r("$KEY"), Resolved::Value("sk-1".into()));
        assert_eq!(r("${KEY}"), Resolved::Value("sk-1".into()));
        assert_eq!(r("a-$KEY-${B}!"), Resolved::Value("a-sk-1-bb!".into()), "串中任意位置插值");
        assert_eq!(r("$$KEY"), Resolved::Value("$KEY".into()));
        assert_eq!(r("$!cmd"), Resolved::Value("!cmd".into()));
        assert_eq!(r("pre$"), Resolved::Value("pre$".into()), "$ 后无变量名 = 字面");
        assert_eq!(r("$1abc"), Resolved::Value("$1abc".into()));
        assert_eq!(r("${KEY"), Resolved::Value("${KEY".into()), "未闭合 = 字面");
        assert_eq!(r("${bad-name}"), Resolved::Value("${bad-name}".into()), "非法名 = 字面");
        assert_eq!(r("!op read x"), Resolved::Command);
        assert_eq!(r("$NOPE"), Resolved::MissingEnv(vec!["NOPE".into()]));
        assert_eq!(r("$EMPTY"), Resolved::MissingEnv(vec!["EMPTY".into()]), "空串视为缺失");
        assert_eq!(r("$NOPE-$NOPE-$X"), Resolved::MissingEnv(vec!["NOPE".into(), "X".into()]));
        assert_eq!(r("中文$KEY尾"), Resolved::Value("中文sk-1尾".into()), "多字节字符不能切坏");
    }

    #[test]
    fn parses_model_list_shapes() {
        assert_eq!(parse_model_list(r#"{"object":"list","data":[{"id":"b"},{"id":"a"},{"id":"a"}]}"#), Some(vec!["a".into(), "b".into()]));
        assert_eq!(parse_model_list(r#"[{"id":"x"},"y"]"#), Some(vec!["x".into(), "y".into()]));
        assert_eq!(parse_model_list(r#"{"models":[{"name":"llama3"}]}"#), Some(vec!["llama3".into()]));
        assert_eq!(parse_model_list(r#"{"data":[]}"#), Some(vec![]), "空列表是合法结果");
        assert_eq!(parse_model_list("<html>hi</html>"), None);
        assert_eq!(parse_model_list(r#"{"error":"x"}"#), None);
        assert_eq!(parse_model_list(r#"{"data":[{"foo":1}]}"#), None, "取不出 id 不是模型列表");
    }

    #[test]
    fn builds_models_url() {
        assert_eq!(build_models_url("https://api.x.com/v1").unwrap(), "https://api.x.com/v1/models");
        assert_eq!(build_models_url(" https://api.x.com/v1// ").unwrap(), "https://api.x.com/v1/models");
        assert_eq!(build_models_url("http://127.0.0.1:8090/v1").unwrap(), "http://127.0.0.1:8090/v1/models");
        assert_eq!(build_models_url("HTTPS://api.x.com/v1").unwrap(), "HTTPS://api.x.com/v1/models");
        assert!(build_models_url("").unwrap_err().contains("未填写"));
        assert!(build_models_url("api.x.com/v1").unwrap_err().contains("http:// 或 https://"));
        assert!(build_models_url("ftp://x.com").unwrap_err().contains("http"));
        assert!(build_models_url("http://").is_err());
    }

    #[test]
    fn proxy_follows_pi_precedence() {
        let none = env_of(&[]);
        assert_eq!(proxy_plan(None, &none), ProxyPlan { http: None, https: None });
        assert_eq!(
            proxy_plan(Some(" http://p:1 "), &none),
            ProxyPlan { http: Some("http://p:1".into()), https: Some("http://p:1".into()) }
        );
        // 环境变量优先, settings 只补缺的那个
        let only_https = env_of(&[("HTTPS_PROXY", "http://env:2")]);
        assert_eq!(
            proxy_plan(Some("http://p:1"), &only_https),
            ProxyPlan { http: Some("http://p:1".into()), https: Some("http://env:2".into()) }
        );
        let lower = env_of(&[("http_proxy", "http://lower:3"), ("HTTP_PROXY", "http://upper:4")]);
        assert_eq!(proxy_plan(None, &lower).http, Some("http://lower:3".into()), "undici 小写优先");
        assert_eq!(proxy_plan(Some("  "), &none), ProxyPlan { http: None, https: None });
    }

    #[test]
    fn snippet_redacts_before_truncating() {
        let key = "sk-secret";
        let body = format!("{}{key}{}", "x".repeat(195), "y".repeat(50));
        let s = snippet_of(&body, key);
        assert!(!s.contains("sk-sec"), "密钥跨截断边界也不能漏出: {s}");
        assert!(s.ends_with('…'));
    }

    /// 不发网络请求的早退分支 (A15: 暂不支持的接口 / 命令密钥必须不发请求)
    #[tokio::test]
    async fn early_exits_without_network() {
        let env = env_of(&[("K", "sk")]);
        let cases = [
            (json!({ "api": "anthropic-messages", "baseUrl": "https://x/v1", "apiKey": "sk" }), "unsupported_api", "anthropic-messages"),
            (json!({ "api": "openai-completions", "baseUrl": "https://x/v1", "apiKey": "!op read" }), "unsupported_key", "!命令"),
            (json!({ "api": "openai-completions", "baseUrl": "https://x/v1", "apiKey": "sk", "headers": { "X": "!cmd" } }), "unsupported_key", "header X"),
            (json!({ "api": "openai-completions", "baseUrl": "https://x/v1", "apiKey": "$MISSING" }), "no_key", "MISSING"),
            (json!({ "api": "openai-completions", "baseUrl": "https://x/v1" }), "no_key", "apiKey"),
            (json!({ "api": "openai-completions", "baseUrl": "not a url", "apiKey": "$K" }), "invalid_url", "地址"),
            (json!({ "api": "openai-completions", "baseUrl": "https://x/v1", "apiKey": "sk", "headers": { "X": "$MISSING_H" } }), "no_key", "header X"),
        ];
        for (p, kind, frag) in cases {
            let r = probe(&p, None, &env).await.unwrap();
            assert!(!r.ok);
            assert_eq!(r.error_kind.as_deref(), Some(kind), "{p}");
            assert!(r.message.as_deref().unwrap_or("").contains(frag), "{p}: {:?}", r.message);
            assert_eq!(r.status, None, "早退分支不该发请求: {p}");
        }
    }
}
