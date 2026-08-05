// M4: 会话文件系统数据源 (独立于 pi 子进程, 纯文件扫描)
// 数据源: ~/.pi/agent/sessions/ 目录 + settings.json / models.json
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 侧边栏项目节点
#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectInfo {
    pub path: String,          // 反解后的项目路径 (如 C:\workspace\hanjiang\xxx)
    pub display_name: String,  // 展示名 (路径最后一段)
    pub sessions: Vec<SessionInfo>,
}

/// 单个会话文件
#[derive(Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    pub file_name: String,    // 时间戳_uuid.jsonl
    pub session_path: String, // 绝对路径
    pub timestamp: String,    // 文件名里的 UTC 时间戳
    pub session_id: String,   // uuid
    pub preview: String,      // 首条 user 消息摘要
}

pub(crate) fn agent_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法确定用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".pi").join("agent"))
}

/// sessions 根目录 (canonicalize 失败时回退原始路径, 供路径越界校验用)
/// agent_dir 失败必须上抛: 回退空路径会让 starts_with("") 恒真 → 越界校验 fail-open (安全回归)
fn sessions_root() -> Result<PathBuf, String> {
    let sessions = agent_dir()?.join("sessions");
    Ok(sessions.canonicalize().unwrap_or(sessions))
}

/// 目录名有损反解 (回退方案): pi 编码是 replace(/[/\\:]/g,"-"), `-` 无法区分分隔符和字面量
/// 权威路径来自会话文件首行 cwd, 这里只做近似: 首段补盘符冒号, 其余按字面量保留
fn decode_project_dir(dir_name: &str) -> String {
    let inner = dir_name.trim_matches('-');
    let parts: Vec<&str> = inner.split("--").filter(|s| !s.is_empty()).collect();
    let mut out = String::new();
    for (i, seg) in parts.iter().enumerate() {
        if i > 0 {
            out.push('\\');
        }
        // 首段单字母 = Windows 盘符 (C:)
        if i == 0 && seg.len() == 1 && seg.chars().next().unwrap().is_ascii_alphabetic() {
            out.push_str(&format!("{}:", seg));
        } else {
            out.push_str(seg);
        }
    }
    out
}

/// 会话预览: 读首行 session 头 (取 cwd + uuid) + 最新 session_info name + 首条 user 消息前 100 字符
/// 返回 (session_id, preview, cwd) — cwd 是会话头里的权威项目路径
fn read_session_preview(path: &Path) -> (String, String, String) {
    let Ok(file) = std::fs::File::open(path) else {
        return (String::new(), String::new(), String::new());
    };
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut preview = String::new();
    let mut info_name: Option<String> = None;
    for line in reader.lines().take(500) {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            // 首行 session 头: 取 uuid + 权威 cwd
            Some("session") => {
                session_id = v
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .to_string();
                cwd = v
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            // 重命名记录 (set_session_name): 最新一条优先作为标题
            Some("session_info") => {
                let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if !name.is_empty() {
                    info_name = Some(name.to_string());
                }
            }
            // 第一条 user 消息: 取 text 块拼接, 截断 100 字符后停止
            Some("message") => {
                let Some(msg) = v.get("message") else { continue };
                if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
                    continue;
                }
                let text = msg
                    .get("content")
                    .and_then(|c| c.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|block| {
                                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    block.get("text").and_then(|t| t.as_str())
                                } else {
                                    None
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default();
                if !text.is_empty() {
                    let mut chars = text.chars();
                    preview = chars.by_ref().take(100).collect::<String>();
                    if chars.next().is_some() {
                        preview.push('…');
                    }
                    break;
                }
            }
            _ => {}
        }
    }
    // 有 session_info 重命名记录时, 标题优先用 name; 否则用首条 user 消息
    if let Some(name) = info_name {
        preview = name;
    }
    (session_id, preview, cwd)
}

/// 扫描 ~/.pi/agent/sessions/: 子目录=项目, 顶层 *.jsonl=会话
/// 嵌套 run/分支目录 (xxx/<hash>/run-0/session.jsonl) 不取
#[tauri::command]
pub fn list_projects_and_sessions() -> Result<Vec<ProjectInfo>, String> {
    let sessions_root = agent_dir()?.join("sessions");
    let mut projects = Vec::new();
    let Ok(entries) = std::fs::read_dir(&sessions_root) else {
        return Err(format!("无法读取会话目录: {}", sessions_root.display()));
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(dir_name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        // 会话文件按文件名时间戳倒序 (UTC ISO 字符串可直接字典序比较)
        // 同时收集会话头 cwd (权威项目路径) — 有损反解无法可靠还原
        let mut sessions: Vec<SessionInfo> = Vec::new();
        let mut project_cwd: Option<String> = None;
        let Ok(files) = std::fs::read_dir(&path) else { continue };
        for f in files.flatten() {
            let fpath = f.path();
            if fpath.is_dir() || fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(file_name) = f.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };
            // 文件名 = 时间戳_uuid.jsonl
            let (ts, uuid) = match file_name.split_once('_') {
                Some((ts, rest)) => (ts.to_string(), rest.trim_end_matches(".jsonl").to_string()),
                None => continue,
            };
            let (id, preview, cwd) = read_session_preview(&fpath);
            if project_cwd.is_none() && !cwd.is_empty() {
                project_cwd = Some(cwd);
            }
            sessions.push(SessionInfo {
                session_id: if id.is_empty() { uuid } else { id },
                file_name,
                session_path: fpath.to_string_lossy().to_string(),
                timestamp: ts,
                preview,
            });
        }
        sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        // 项目路径: 会话头的 cwd 是权威 (pi 编码有损, 目录名不可信); 无会话时回退有损反解
        let path_str = project_cwd.unwrap_or_else(|| decode_project_dir(&dir_name));
        projects.push(ProjectInfo {
            display_name: Path::new(&path_str)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path_str.clone()),
            path: path_str,
            sessions,
        });
    }
    // 项目按路径字母序 (顺序由前端拖拽持久化接管)
    projects.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(projects)
}

/// 路径安全校验: 校验 path 位于 sessions 根目录内, 返回 canonicalize 后的绝对路径
/// 命令层职责 (解析函数本身不做校验, 便于纯解析测试用任意路径)
pub(crate) fn ensure_within_sessions(path: &Path) -> Result<PathBuf, String> {
    let target_abs = path.canonicalize().map_err(|e| format!("会话文件不存在: {e}"))?;
    if !target_abs.starts_with(sessions_root()?) {
        return Err("拒绝读取 sessions 目录外的文件".into());
    }
    Ok(target_abs)
}

/// 解析会话 jsonl 为 entries (零 pi 进程依赖, ~1ms):
/// 逐行解析, 空行/坏行跳过, 过滤 session 头, 其余原样 JSON 透传
/// 契约对齐 pi get_entries (getEntries = fileEntries.filter(e => e.type !== "session")), 前端 mapHistoryEntries 可零改动复用
/// 注意: 调用方须先做路径安全校验 (ensure_within_sessions)
pub(crate) fn read_session_entries(path: &Path) -> Result<Vec<serde_json::Value>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("读取会话文件失败: {e}"))?;
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| format!("读取会话文件失败: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        // 坏行容错: 单行 JSON 解析失败跳过 (文件追加中读到半行、手改坏行等)
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        // 过滤 session 头: 首行 type=="session" (pi getEntries 同样过滤)
        if v.get("type").and_then(|t| t.as_str()) == Some("session") {
            continue;
        }
        entries.push(v);
    }
    Ok(entries)
}

/// 目录项 (文件树懒加载用)
#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,  // 文件大小字节 (目录为 None)
    pub mtime: Option<u64>, // 修改时间戳秒 (不可得为 None)
}

/// Windows verbatim 前缀 (\\?\) 转普通路径: canonicalize 产物会带前缀,
/// 但发给 agent 的引用路径必须是干净格式 (跨工具链兼容)
fn to_plain_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\")
        .map(|x| x.to_string())
        .unwrap_or_else(|| s.to_string())
}

/// 列出目录内容 (文件树懒加载): 目录优先, 各自按名称排序
/// root 参数用于越界校验: 只允许浏览 root 内的路径 (文件树从项目根起步)
#[tauri::command]
pub fn list_dir(root: String, path: String) -> Result<Vec<DirEntry>, String> {
    let root_abs = std::fs::canonicalize(&root)
        .unwrap_or_else(|_| PathBuf::from(&root));
    let dir_abs = std::fs::canonicalize(&path)
        .unwrap_or_else(|_| PathBuf::from(&path));
    if !dir_abs.starts_with(&root_abs) {
        return Err("拒绝浏览项目根目录外的路径".into());
    }
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir_abs).map_err(|e| format!("读取目录失败: {e}"))? {
        let item = item.map_err(|e| format!("读取目录项失败: {e}"))?;
        let meta = item.metadata().map_err(|e| format!("读取元信息失败: {e}"))?;
        entries.push(DirEntry {
            name: item.file_name().to_string_lossy().to_string(),
            path: to_plain_path(&item.path()),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { Some(meta.len()) } else { None },
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
        });
    }
    // 目录优先, 各自按名称不区分大小写排序
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// 常见重目录递归扫描时跳过: 与前端 FileTreePicker 的 HIDDEN_DIRS 对齐,
/// 避免 node_modules/.git 等目录把 @ 引用候选列表撑爆/拖慢扫描
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "target", ".next", ".turbo",
    "build", ".cache", "__pycache__", ".venv", "venv", ".trellis",
];

/// 递归扫描项目全部文件 (@ 引用文件源): 手写 std::fs, 只收文件不收目录,
/// 跳过重目录, 目录序遍历按名称排序保证输出稳定; 大项目由前端异步 loading 态承接
#[tauri::command]
pub fn list_files_recursive(root: String) -> Result<Vec<DirEntry>, String> {
    let root_path = PathBuf::from(&root);
    let meta = std::fs::metadata(&root_path).map_err(|e| format!("项目目录不可读: {e}"))?;
    if !meta.is_dir() {
        return Err("项目根不是目录".into());
    }

    fn walk(dir: &Path, out: &mut Vec<DirEntry>) -> Result<(), String> {
        let mut items: Vec<(std::ffi::OsString, std::fs::Metadata)> = Vec::new();
        for item in std::fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))? {
            // 单条目读失败 (权限/占用/OneDrive 占位) 直接跳过: @ 引用是低风险功能, 一颗老鼠屎不坏一锅汤
            let Ok(item) = item else { continue; };
            // metadata() 不跟随 symlink: symlink 的 is_dir/is_file 均 false → 静默跳过,
            // 恰好防符号链接循环 + 防越出项目根 (指向文件的链接也因此不进候选, 已知取舍)
            let Ok(meta) = item.metadata() else { continue; };
            items.push((item.file_name(), meta));
        }
        // 先收集再按名称排序: 保证输出顺序稳定 (子目录递归顺序确定)
        items.sort_by(|a, b| a.0.to_string_lossy().to_lowercase().cmp(&b.0.to_string_lossy().to_lowercase()));
        for (name, meta) in items {
            let path = dir.join(&name);
            let name_str = name.to_string_lossy();
            if meta.is_dir() {
                if !SKIP_DIRS.contains(&name_str.as_ref()) {
                    // 子目录不可读仅跳过该目录, 不中断整个扫描 (与单条目容错同理)
                    let _ = walk(&path, out);
                }
            } else if meta.is_file() {
                out.push(DirEntry {
                    name: name_str.to_string(),
                    path: to_plain_path(&path),
                    is_dir: false,
                    size: Some(meta.len()),
                    mtime: meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs()),
                });
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    walk(&root_path, &mut files)?;
    Ok(files)
}

/// 读取历史会话 entries (前端「引用会话消息」用): 复用直读实现, 带路径安全校验
#[tauri::command]
pub fn read_session_entries_public(session_path: String) -> Result<Vec<serde_json::Value>, String> {
    let abs = ensure_within_sessions(Path::new(&session_path))?;
    read_session_entries(&abs)
}

/// 删除会话文件 (校验路径必须位于 sessions 根目录下, 防误删任意路径)
#[tauri::command]
pub fn delete_session_file(session_path: String) -> Result<(), String> {
    let target_abs = ensure_within_sessions(&PathBuf::from(&session_path))?;
    std::fs::remove_file(&target_abs).map_err(|e| format!("删除失败: {e}"))?;
    // token 统计索引联动: 移除该文件条目, 防止统计虚高 (不要求索引已初始化)
    crate::token_stats::remove_index_file(&target_abs);
    Ok(())
}

/// 读取文件用于上下文引用: 图片 → base64, 文本 → 内容 (100KB 截断)
/// 返回 { kind: "image", data, mimeType, fileName } 或 { kind: "text", content, fileName }
#[tauri::command]
pub fn read_file_for_context(file_path: String) -> Result<serde_json::Value, String> {
    use base64::Engine as _;
    let path = PathBuf::from(&file_path);
    if !path.is_file() {
        return Err("文件不存在".into());
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    // 图片: base64 + mimeType (走 pi prompt 的 images 字段)
    let is_image = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp");
    if is_image {
        let data = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "application/octet-stream",
        };
        return Ok(serde_json::json!({
            "kind": "image",
            "data": base64::engine::general_purpose::STANDARD.encode(&data),
            "mimeType": mime,
            "fileName": file_name,
        }));
    }
    // 文本: UTF-8 内容, 100KB 截断; 行数/大小供引用 chips 元信息展示
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
    let raw = String::from_utf8_lossy(&bytes);
    let lines = raw.lines().count();
    let content: String = if raw.chars().count() > 100_000 {
        raw.chars().take(100_000).collect::<String>() + "\n…(内容过长已截断)"
    } else {
        raw.to_string()
    };
    Ok(serde_json::json!({
        "kind": "text",
        "content": content,
        "fileName": file_name,
        "path": path.to_string_lossy(),
        "size": bytes.len(),
        "lines": lines,
    }))
}

/// skill / package / provider 列表 (只读, 不修改 pi 配置)
/// { skills: [{name, description, path}], packages: [String], providers: [String] }
#[tauri::command]
pub fn list_skills_and_packages() -> Result<serde_json::Value, String> {
    let agent = agent_dir()?;
    // skills: ~/.pi/agent/skills/<name>/SKILL.md 的 frontmatter (name/description)
    let mut skills = Vec::new();
    let skills_root = agent.join("skills");
    if let Ok(entries) = std::fs::read_dir(&skills_root) {
        for entry in entries.flatten() {
            let skill_dir = entry.path();
            if !skill_dir.is_dir() {
                continue;
            }
            let skill_md = skill_dir.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&skill_md) else { continue };
            let mut name = entry.file_name().to_string_lossy().to_string();
            let mut description = String::new();
            // frontmatter: ---\nname: xxx\ndescription: xxx\n---
            if let Some(rest) = text.strip_prefix("---") {
                if let Some(end) = rest.find("\n---") {
                    let fm = &rest[..end];
                    for line in fm.lines() {
                        if let Some(v) = line.strip_prefix("name:") {
                            name = v.trim().to_string();
                        } else if let Some(v) = line.strip_prefix("description:") {
                            description = v.trim().to_string();
                        }
                    }
                }
            }
            skills.push(serde_json::json!({
                "name": name,
                "description": description,
                "path": skill_md.to_string_lossy().to_string(),
            }));
        }
    }
    // packages + 默认偏好: settings.json
    let mut packages = Vec::new();
    let mut defaults = serde_json::json!({});
    let settings_path = agent.join("settings.json");
    if let Ok(text) = std::fs::read_to_string(&settings_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            packages = v
                .get("packages")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| s.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            defaults = serde_json::json!({
                "defaultProvider": v.get("defaultProvider").and_then(|x| x.as_str()).unwrap_or(""),
                "defaultModel": v.get("defaultModel").and_then(|x| x.as_str()).unwrap_or(""),
                "defaultThinkingLevel": v.get("defaultThinkingLevel").and_then(|x| x.as_str()).unwrap_or(""),
            });
        }
    }
    // providers: models.json 的顶层键
    let mut providers = Vec::new();
    let models_path = agent.join("models.json");
    if let Ok(text) = std::fs::read_to_string(&models_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            providers = v
                .get("providers")
                .and_then(|p| p.as_object())
                .map(|obj| obj.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            providers.sort();
        }
    }
    Ok(serde_json::json!({
        "skills": skills,
        "packages": packages,
        "providers": providers,
        "defaults": defaults,
    }))
}

/// 获取会话 jsonl 文件修改时间 (ms 时间戳); 文件不存在或无路径返回 None
/// 供前端 mtime 守卫: 切回会话时比对磁盘 mtime 与缓存 baseline, 没变就不重读 entries
#[tauri::command]
pub fn get_session_file_mtime(session_path: Option<String>) -> Result<Option<f64>, String> {
    let Some(path) = session_path else { return Ok(None) };
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Ok(None);
    }
    let modified = std::fs::metadata(&p)
        .map_err(|e| format!("读取文件元数据失败: {e}"))?
        .modified()
        .map_err(|e| format!("读取修改时间失败: {e}"))?;
    let ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("时间转换失败: {e}"))?
        .as_millis() as f64;
    Ok(Some(ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造临时 jsonl: session 头 + 3 条有效行 (user/assistant含toolCall/model_change) + 坏行 + 空行
    fn write_fixture(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join("fixture.jsonl");
        let lines = [
            r#"{"type":"session","version":3,"id":"sess-1","cwd":"C:\\workspace\\demo"}"#,
            r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-08-05T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"你好"}]}}"#,
            r#"{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-08-05T00:00:01.000Z","message":{"role":"assistant","provider":"huoshan","model":"glm-5.2","content":[{"type":"thinking","thinking":"想"},{"type":"text","text":"回复"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls"}}]}}"#,
            r#"{"type":"model_change","id":"mc1","parentId":null,"timestamp":"2026-08-05T00:00:02.000Z","provider":"huoshan","modelId":"glm-5.2"}"#,
            "this is not json",
            "",
        ];
        std::fs::write(&p, lines.join("\n")).unwrap();
        p
    }

    /// 契约对齐 pi getEntries: 过滤 session 头 + 坏行/空行跳过 + 其余原样透传
    #[test]
    fn parses_entries_aligned_with_pi_contract() {
        let dir = std::env::temp_dir().join(format!("sfe_parse_{}", std::process::id()));
        let p = write_fixture(&dir);
        let entries = read_session_entries(&p).unwrap();
        // session 头被过滤, 坏行/空行跳过 → 剩 3 条 (m1/m2/mc1)
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["type"], "message");
        assert_eq!(entries[0]["id"], "m1");
        // message 内部结构原样透传 (前端 mapHistoryEntries 依赖的字段)
        let msg = &entries[1]["message"];
        assert_eq!(msg["role"], "assistant");
        assert_eq!(msg["content"][0]["type"], "thinking");
        assert_eq!(msg["content"][2]["type"], "toolCall");
        assert_eq!(msg["content"][2]["arguments"]["command"], "ls");
        assert_eq!(entries[2]["type"], "model_change");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 路径越界拒绝: 系统临时目录必然不在 ~/.pi/agent/sessions 内
    #[test]
    fn rejects_path_outside_sessions_root() {
        let outside = std::env::temp_dir().join(format!("sfe_outside_{}.jsonl", std::process::id()));
        std::fs::write(&outside, "{}").unwrap();
        let err = ensure_within_sessions(&outside).unwrap_err();
        assert!(err.contains("拒绝"), "错误信息应说明拒绝读取: {err}");
        std::fs::remove_file(&outside).ok();
    }

    /// 文件不存在 → 明确错误
    #[test]
    fn rejects_missing_file() {
        let p = std::env::temp_dir().join(format!("sfe_missing_{}.jsonl", std::process::id()));
        let err = read_session_entries(&p).unwrap_err();
        assert!(err.contains("读取会话文件失败"), "错误信息应带定位: {err}");
    }
}
