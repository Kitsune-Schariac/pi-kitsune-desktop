//! @ 引用文件搜索 (Everything 加速层)
//!
//! 调 es.exe 做项目根内的毫秒级路径搜索, 替代 @ 引用打开时的一次性全量扫描。
//! 任何失败 (es 缺失 / 超时 / 非零退出) 都返回 Err, 前端据此静默降级回
//! list_files_recursive 全量路径 —— 本命令是可选的增强层, 绝不允许让 @ 引用
//! 整体不可用。

use std::process::Stdio;
use std::time::Duration;

use crate::session_fs::DirEntry;
use crate::session_fs::SKIP_DIRS;

/// 单次搜索返回条数上限: es 结果可能上千 (含 target/node_modules 的碎片),
/// 前端展示只需前 50, 截断防大列表拖慢 IPC 序列化
const MAX_RESULTS: usize = 200;

/// Everything 命令超时: Everything 未运行时 es 会挂起等待 IPC, 500ms 后放弃走降级
const ES_TIMEOUT: Duration = Duration::from_millis(500);

/// 项目根内搜索文件名/路径段 (@ 引用候选源)
///
/// query 语义与前端一致: 用户输入正斜杠多级路径 (yfz/index), Everything 只认
/// 反斜杠路径段, 这里统一转换后交给 es.exe; 结果限定在 root 边界内, 只收文件
/// (与 list_files_recursive 对齐, 目录引用无意义), 跳过重目录。
#[tauri::command]
pub async fn search_files(query: String, root: String) -> Result<Vec<DirEntry>, String> {
    // 非 Windows 平台没有 es.exe, 直接发降级信号; Windows 上 es 不在 PATH 时
    // spawn 失败也会走同样的 Err 分支 (见下方 map_err)
    if !cfg!(windows) {
        return Err("Everything 搜索仅支持 Windows".into());
    }
    let q = query.replace('/', "\\");
    let root_norm = root.trim_end_matches(['\\', '/']).to_lowercase();
    if root_norm.is_empty() {
        return Err("项目根为空".into());
    }

    // es.exe 输出可能挂起 (Everything 服务未启动), 用 tokio timeout 兜底;
    // -match-path: 单段词也按完整路径匹配, 与前端 score 的路径子串语义对齐
    // (不加时 es 只按名称匹配, 输入 yfz 会漏掉 yfz\index.vue 这类路径命中)
    let output = tokio::time::timeout(
        ES_TIMEOUT,
        tokio::process::Command::new("es")
            .args(["-path", &root, "-match-path", &q])
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "Everything 搜索超时".to_string())?
    .map_err(|e| format!("启动 es.exe 失败: {e}"))?;

    if !output.status.success() {
        return Err(format!("es.exe 搜索失败: {}", output.status));
    }

    // es 管道输出是 ANSI (GBK) 编码: 中文路径/文件名必须转码, 否则前端乱码
    let (text, _, _) = encoding_rs::GBK.decode(&output.stdout);

    let mut out: Vec<DirEntry> = Vec::new();
    for line in text.lines() {
        if out.len() >= MAX_RESULTS {
            break;
        }
        // es 输出行尾带 CRLF, lines() 已去掉 \n, 这里补去 \r
        let path = line.trim_end_matches('\r');
        if path.is_empty() {
            continue;
        }
        if !within_root(path, &root_norm) {
            continue;
        }
        // 与 list_files_recursive 的重目录跳过清单保持一致
        if in_skip_dir(path) {
            continue;
        }
        // 只收文件: 目录引用无意义 (PathRef 面向文件), 与现有全量扫描行为对齐;
        // 顺带取 size/mtime 填充 meta
        let Ok(meta) = std::fs::metadata(path) else { continue };
        if !meta.is_file() {
            continue;
        }
        out.push(DirEntry {
            name: basename(path).to_string(),
            path: path.to_string(),
            is_dir: false,
            size: Some(meta.len()),
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
        });
    }
    Ok(out)
}

/// root 边界过滤: 大小写不敏感 + 尾分隔符边界, 防 C:\workspace\ZhiKuYun
/// 误含 C:\workspace\ZhiKuYun-drgs 这类前缀相似目录
fn within_root(path: &str, root_norm: &str) -> bool {
    let p = path.trim_end_matches(['\\', '/']).to_lowercase();
    p == root_norm || p.starts_with(&format!("{root_norm}\\"))
}

/// 路径任一目录段命中重目录清单 (node_modules/.git/target/...) 则跳过
fn in_skip_dir(path: &str) -> bool {
    path.split(['\\', '/'])
        .any(|seg| SKIP_DIRS.contains(&seg))
}

fn basename(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_boundary_filter() {
        // root 精确匹配
        assert!(within_root(r"C:\workspace\ZhiKuYun", "c:\\workspace\\zhikuyun"));
        // root 内文件
        assert!(within_root(r"C:\workspace\ZhiKuYun\src\index.vue", "c:\\workspace\\zhikuyun"));
        // 前缀相似目录必须排除 (root 边界 bug 的核心)
        assert!(!within_root(r"C:\workspace\ZhiKuYun-drgs\x.txt", "c:\\workspace\\zhikuyun"));
        assert!(!within_root(r"C:\workspace\ZhiKuYunny\x.txt", "c:\\workspace\\zhikuyun"));
        // 大小写不敏感
        assert!(within_root(r"C:\WORKSPACE\ZHIKUYUN\a.txt", "c:\\workspace\\zhikuyun"));
    }

    #[test]
    fn skip_dir_filter() {
        assert!(in_skip_dir(r"C:\proj\node_modules\lodash\index.js"));
        assert!(in_skip_dir(r"C:\proj\src\..\node_modules\x.js"));
        assert!(in_skip_dir(r"C:\proj\target\debug\x.rs"));
        assert!(!in_skip_dir(r"C:\proj\src\components\App.tsx"));
        assert!(!in_skip_dir(r"C:\proj\skilled\nodejs.md"));
    }

    #[test]
    fn basename_extract() {
        assert_eq!(basename(r"C:\a\b\c.vue"), "c.vue");
        assert_eq!(basename("C:/a/b/d.ts"), "d.ts");
        assert_eq!(basename("file.txt"), "file.txt");
    }

    #[test]
    fn gbk_decode_chinese() {
        // "汉江" 的 GBK 字节
        let bytes: &[u8] = &[0xba, 0xba, 0xbd, 0xad];
        let (text, _, _) = encoding_rs::GBK.decode(bytes);
        assert_eq!(text, "汉江");
        // 纯 ASCII 也兼容
        let (text2, _, _) = encoding_rs::GBK.decode(br"C:\workspace\x.txt");
        assert_eq!(text2, r"C:\workspace\x.txt");
    }

    #[test]
    fn query_slash_to_backslash() {
        // 用户输入正斜杠多级路径 → es 可识别的反斜杠
        assert_eq!(r"yfz\index".to_string(), "yfz/index".replace('/', "\\"));
    }

    /// 真实 es.exe 集成验证: 依赖本机 Everything 运行中, 默认忽略
    #[tokio::test]
    #[ignore]
    async fn es_integration_search() {
        let root = r"C:\workspace\hanjiang\pi-kitsune-desktop".to_string();
        let res = search_files("MentionPopup".to_string(), root.clone()).await;
        let files = res.expect("es 搜索应成功");
        assert!(
            files.iter().any(|f| f.name == "MentionPopup.tsx"),
            "应搜到 MentionPopup.tsx, 实际: {:?}",
            files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>()
        );
        // 结果全部限定在 root 内且是文件
        for f in &files {
            assert!(f.path.starts_with(&root), "越界: {}", f.path);
            assert!(!f.is_dir);
        }
    }

    /// 中文查询链路验证 (Rust Command::args 传 UTF-16, es 收到正确宽字符)
    #[tokio::test]
    #[ignore]
    async fn es_integration_chinese() {
        let root = r"C:\workspace\hanjiang\pi-kitsune-desktop".to_string();
        let res = search_files("测试中文文件".to_string(), root).await;
        let files = res.expect("中文搜索应成功");
        assert!(
            files.iter().any(|f| f.name == "测试中文文件.md"),
            "应搜到中文文件, 实际: {:?}",
            files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>()
        );
    }
}
