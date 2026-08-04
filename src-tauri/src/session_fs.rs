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

/// 删除会话文件 (校验路径必须位于 sessions 根目录下, 防误删任意路径)
#[tauri::command]
pub fn delete_session_file(session_path: String) -> Result<(), String> {
    let sessions_root = agent_dir()?.join("sessions").canonicalize().unwrap_or_else(|_| agent_dir().unwrap().join("sessions"));
    let target = PathBuf::from(&session_path);
    let target_abs = target.canonicalize().map_err(|e| format!("会话文件不存在: {e}"))?;
    if !target_abs.starts_with(&sessions_root) {
        return Err("拒绝删除 sessions 目录外的文件".into());
    }
    std::fs::remove_file(&target_abs).map_err(|e| format!("删除失败: {e}"))
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
    // 文本: UTF-8 内容, 100KB 截断
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
    let content = String::from_utf8_lossy(&bytes);
    let content: String = if content.chars().count() > 100_000 {
        content.chars().take(100_000).collect::<String>() + "\n…(内容过长已截断)"
    } else {
        content.to_string()
    };
    Ok(serde_json::json!({
        "kind": "text",
        "content": content,
        "fileName": file_name,
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
