// 输入框附件: 资源管理器复制后粘贴的文件 / 拖进窗口的文件 → 引用条目
// 路径必须在 Rust 侧解析: 网页里的 File 对象不带真实路径, 而文本文件走「路径模式」
// (只发 [引用文件: path], agent 按需读) 离不开路径。图片读成 base64, 视觉模型要的是像素
use crate::session_fs::image_mime;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::PathBuf;

/// 超过这个体积的图片不内联, 退回路径模式: 几十 MB 的 base64 走一趟 IPC 会卡住界面,
/// 而 pi 发送前本来就会把图片缩放到模型上限, 内联超大原图没有收益
const MAX_INLINE_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 路径列表 → 附件条目, 条目形态 (kind 判别):
/// image { fileName, path, data, mimeType } / file { fileName, path, size } /
/// dir { fileName, path } / error { fileName, path, message }
/// 单个路径失败不连累同批其它文件, 错误作为条目返回, 由前端汇总提示
fn resolve_attachments(paths: Vec<PathBuf>) -> Vec<Value> {
    paths
        .into_iter()
        .map(|path| {
            let path_str = path.to_string_lossy().to_string();
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path_str.clone());
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    return json!({
                        "kind": "error", "fileName": file_name, "path": path_str,
                        "message": format!("无法访问: {e}"),
                    })
                }
            };
            if meta.is_dir() {
                return json!({ "kind": "dir", "fileName": file_name, "path": path_str });
            }
            if let Some(mime) = image_mime(&path).filter(|_| meta.len() <= MAX_INLINE_IMAGE_BYTES) {
                return match std::fs::read(&path) {
                    Ok(data) => json!({
                        "kind": "image", "fileName": file_name, "path": path_str,
                        "data": base64::engine::general_purpose::STANDARD.encode(&data),
                        "mimeType": mime,
                    }),
                    Err(e) => json!({
                        "kind": "error", "fileName": file_name, "path": path_str,
                        "message": format!("读取失败: {e}"),
                    }),
                };
            }
            // 非图片只取元信息不读内容: 路径模式用不到内容, 粘贴个几 GB 的视频也不该整个读进内存
            json!({ "kind": "file", "fileName": file_name, "path": path_str, "size": meta.len() })
        })
        .collect()
}

/// 读剪贴板里的文件列表 (CF_HDROP, 资源管理器「复制」产生) 并解析成附件条目。
/// 剪贴板里没有文件 (截图位图 / 纯文本) 是常态, 返回空数组而不是错误
/// async: 图片读盘 + base64 可能上百毫秒, 同步 command 跑在主线程会卡住窗口
#[tauri::command]
pub async fn read_clipboard_attachments() -> Result<Vec<Value>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败: {e}"))?;
    let paths = match clipboard.get().file_list() {
        Ok(p) => p,
        Err(arboard::Error::ContentNotAvailable) => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取剪贴板文件失败: {e}")),
    };
    Ok(resolve_attachments(paths))
}

/// 拖进窗口的文件路径 (Tauri drag-drop 事件给出) 解析成附件条目
#[tauri::command]
pub async fn resolve_attachment_paths(paths: Vec<String>) -> Result<Vec<Value>, String> {
    Ok(resolve_attachments(paths.into_iter().map(PathBuf::from).collect()))
}
