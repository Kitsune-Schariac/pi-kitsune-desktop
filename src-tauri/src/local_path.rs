// 会话里的本地路径: 解析 (相对 cwd / 行号后缀 / 文本判定) + 程序内查看器读文件 + 系统打开 / 定位
// 打开与定位走后端 OpenerExt 而非 opener 的 JS API: 前端未装 @tauri-apps/plugin-opener,
// 且 JS API 要额外配 path scope; 后端已有 open_skins_dir 同款用法
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri_plugin_opener::OpenerExt;

/// 查看器最多读 1MB: 再大的文件逐行渲染 + 高亮会卡住 WebView, 也不是「看一眼」的场景
const VIEW_LIMIT: u64 = 1024 * 1024;

/// 明确的二进制扩展名: 不必读盘嗅探, 直接交给系统默认程序
const BINARY_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svgz", "tif", "tiff", "psd",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
    "zip", "7z", "rar", "gz", "tgz", "bz2", "xz", "tar", "jar", "war", "apk", "msi",
    "exe", "dll", "so", "dylib", "lib", "obj", "o", "a", "pdb", "class", "pyc", "wasm", "node",
    "mp3", "wav", "flac", "ogg", "m4a", "mp4", "mkv", "avi", "mov", "webm",
    "ttf", "otf", "woff", "woff2", "db", "sqlite", "bin", "dat", "iso",
];

#[derive(Serialize)]
pub struct ResolvedPath {
    /// 解析后的绝对路径 (已去掉行号后缀)
    pub path: String,
    /// "text" 走程序内查看器 | "file" 非文本文件 | "dir" 目录
    pub kind: &'static str,
    pub line: Option<u32>,
}

#[derive(Serialize)]
pub struct TextFile {
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    /// 实际使用的解码: "UTF-8" | "GBK"
    pub encoding: &'static str,
}

/// 剥离行号后缀: `#L42` / `#L42-L50` / `:42` / `:42:7`。
/// 剥完剩下的部分必须还像路径 (长于单个盘符), 防止把 `C:` 当成「C 文件第 N 行」
fn split_line_suffix(raw: &str) -> (&str, Option<u32>) {
    if let Some(i) = raw.rfind("#L") {
        let digits: String = raw[i + 2..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse() {
            return (&raw[..i], Some(n));
        }
    }
    let strip = |s: &str| -> Option<(usize, u32)> {
        let i = s.rfind(':')?;
        let tail = &s[i + 1..];
        if tail.is_empty() || !tail.chars().all(|c| c.is_ascii_digit()) || i < 2 {
            return None;
        }
        Some((i, tail.parse().ok()?))
    };
    match strip(raw) {
        // `:行:列` 两段都是数字时, 前一段才是行号
        Some((i, n)) => match strip(&raw[..i]) {
            Some((j, line)) => (&raw[..j], Some(line)),
            None => (&raw[..i], Some(n)),
        },
        None => (raw, None),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok().map(PathBuf::from)
}

/// 判定文本: 黑名单扩展名 → 否; 其余读前 8KB, 含 NUL 视为二进制
/// (UTF-16 文本也含 NUL, 会被判成二进制交给系统打开, 可接受)
fn is_text_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if BINARY_EXTS.contains(&ext.as_str()) {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else { return false };
    let mut head = Vec::with_capacity(8192);
    if file.take(8192).read_to_end(&mut head).is_err() {
        return false;
    }
    !head.contains(&0)
}

/// 把会话里出现的路径文本解析成绝对路径并分类; 相对路径按会话 cwd 解析
#[tauri::command]
pub fn resolve_local_path(raw: String, cwd: Option<String>) -> Result<ResolvedPath, String> {
    let trimmed = raw.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`');
    let (body, line) = split_line_suffix(trimmed);
    if body.is_empty() {
        return Err("路径为空".into());
    }
    let mut path = if body == "~" {
        home_dir().ok_or("无法确定用户主目录")?
    } else if let Some(rest) = body.strip_prefix("~/").or_else(|| body.strip_prefix("~\\")) {
        home_dir().ok_or("无法确定用户主目录")?.join(rest)
    } else {
        PathBuf::from(body)
    };
    if path.is_relative() {
        let base = cwd.filter(|c| !c.is_empty()).ok_or("相对路径缺少会话目录, 无法解析")?;
        path = PathBuf::from(base).join(path);
    }
    if !path.exists() {
        return Err(format!("路径不存在: {}", path.display()));
    }
    // canonicalize 在 Windows 会产出 \\?\ 前缀, 展示和交给 explorer 都不友好, 只做存在性检查不规范化
    let kind = if path.is_dir() {
        "dir"
    } else if is_text_file(&path) {
        "text"
    } else {
        "file"
    };
    Ok(ResolvedPath { path: path.to_string_lossy().into_owned(), kind, line })
}

/// 程序内查看器读文件: 只读前 1MB; 先按 UTF-8 严格解码, 失败回退 GBK
/// (中文 Windows 下 .bat / .sql 常是 GBK, lossy UTF-8 会整篇乱码)
#[tauri::command]
pub fn read_text_file(path: String) -> Result<TextFile, String> {
    let file = std::fs::File::open(&path).map_err(|e| format!("打开文件失败: {e}"))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut bytes = Vec::new();
    file.take(VIEW_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取失败: {e}"))?;
    let truncated = size > VIEW_LIMIT;
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let utf8 = match std::str::from_utf8(body) {
        Ok(s) => Some(s.to_string()),
        // 截断可能切在多字节字符中间: 错误只出现在末尾 (error_len 为 None) 时仍按 UTF-8 处理
        Err(e) if truncated && e.error_len().is_none() => {
            Some(String::from_utf8_lossy(&body[..e.valid_up_to()]).into_owned())
        }
        Err(_) => None,
    };
    let (content, encoding) = match utf8 {
        Some(s) => (s, "UTF-8"),
        None => (encoding_rs::GBK.decode_without_bom_handling(body).0.into_owned(), "GBK"),
    };
    Ok(TextFile { content, size, truncated, encoding })
}

/// 系统默认程序打开 (目录 → 资源管理器)
#[tauri::command]
pub fn open_local_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("打开失败: {e}"))
}

/// 在资源管理器中定位并选中
#[tauri::command]
pub fn reveal_local_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("定位失败: {e}"))
}

/// 外链交给系统浏览器; 前端已拦截, 这里再校验一次协议, 防止 markdown 里构造的 file: / 自定义协议被拉起
#[tauri::command]
pub fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) {
        return Err(format!("不支持的链接协议: {url}"));
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("打开链接失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_suffix() {
        assert_eq!(split_line_suffix("src/a.ts:42"), ("src/a.ts", Some(42)));
        assert_eq!(split_line_suffix("src/a.ts:42:7"), ("src/a.ts", Some(42)));
        assert_eq!(split_line_suffix("C:\\a\\b.sql:3"), ("C:\\a\\b.sql", Some(3)));
        assert_eq!(split_line_suffix("C:\\a\\b.sql"), ("C:\\a\\b.sql", None));
        assert_eq!(split_line_suffix("README.md#L10-L20"), ("README.md", Some(10)));
        // 单盘符后的数字不当行号
        assert_eq!(split_line_suffix("C:1"), ("C:1", None));
    }
}
