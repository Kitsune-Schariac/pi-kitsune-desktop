// 皮肤注册器: 扫描内置 resources/skins/ (只读, 随应用分发) + 用户 ~/.pi-kitsune/skins/ (可写)
// 皮肤包 = 一个目录: skin.json (元数据 + 色阶 + 背景图引用) + 可选 bg.png / preview.png / override.css
// 契约与前端 ThemeStore 对齐, 见 .trellis/tasks/08-10-theme-skin-system/design.md
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// 皮肤元数据 (list_skins 返回给前端; preview 小图随列表走, 背景大图走 get_skin_asset)
#[derive(Serialize, Clone)]
pub struct SkinMeta {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    /// "light" | "dark", 驱动中性色阶方向 + Shiki 主题 + markdown 文字色
    pub base: String,
    /// RGB 通道值 (空格分隔), 前端写 :root 变量
    pub colors: HashMap<String, String>,
    pub has_bg: bool,
    pub has_override: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_data_uri: Option<String>,
    pub bubble: bool,
}

/// skin.json 解析结构 (override 是 Rust 关键字, rename 处理)
#[derive(Deserialize)]
struct SkinConfig {
    id: String,
    name: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    version: String,
    base: String,
    #[serde(default)]
    colors: HashMap<String, String>,
    #[serde(default)]
    background: Option<String>,
    #[serde(default)]
    preview: Option<String>,
    #[serde(default, rename = "override")]
    override_css: Option<String>,
    /// 皮肤推荐的气泡框开关 (用户未手动改过时生效)
    #[serde(default)]
    bubble: bool,
}

/// 用户皮肤目录 ~/.pi-kitsune/skins (不存在则创建)
fn user_skins_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法确定用户主目录".to_string())?;
    let dir = PathBuf::from(home).join(".pi-kitsune").join("skins");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建皮肤目录失败: {e}"))?;
    Ok(dir)
}

/// 内置皮肤目录: dev 模式 resource_dir=target/debug 且资源复制到 {rd}/resources/skins,
/// 打包后 Windows resource_dir=exe 目录, 资源同样在 {rd}/resources/skins — 取第一个存在的候选
fn bundled_skins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let rd = app
        .path()
        .resource_dir()
        .map_err(|e| format!("定位内置皮肤目录失败: {e}"))?;
    let candidates = [rd.join("resources").join("skins"), rd.join("skins")];
    for c in &candidates {
        if c.is_dir() {
            return Ok(c.clone());
        }
    }
    // 都不存在时返回第一个候选: 调用方 read_dir 失败跳过, 不影响用户皮肤扫描
    Ok(candidates[0].clone())
}

/// 解析单个皮肤目录 → SkinMeta; 目录无有效 skin.json 或 base 非法时返回 None (跳过)
fn parse_skin(dir: &Path) -> Option<SkinMeta> {
    let text = std::fs::read_to_string(dir.join("skin.json")).ok()?;
    let cfg: SkinConfig = serde_json::from_str(&text).ok()?;
    if cfg.id.trim().is_empty() || (cfg.base != "light" && cfg.base != "dark") {
        return None;
    }
    let preview_data_uri = cfg.preview.as_ref().and_then(|name| {
        let data = std::fs::read(dir.join(name)).ok()?;
        Some(format!("data:{};base64,{}", mime_for(name), BASE64.encode(data)))
    });
    Some(SkinMeta {
        id: cfg.id,
        name: cfg.name,
        author: cfg.author,
        version: cfg.version,
        base: cfg.base,
        colors: cfg.colors,
        has_bg: cfg.background.as_ref().is_some_and(|n| dir.join(n).exists()),
        has_override: cfg.override_css.as_ref().is_some_and(|n| dir.join(n).exists()),
        preview_data_uri,
        bubble: cfg.bubble,
    })
}

/// 合并两处皮肤列表: id 冲突时内置优先 (用户皮肤被覆盖), 按 id 排序稳定展示
#[tauri::command]
pub fn list_skins(app: tauri::AppHandle) -> Result<Vec<SkinMeta>, String> {
    let bdir = bundled_skins_dir(&app)?;
    eprintln!("[skins] bdir = {}", bdir.display());
    let mut map: HashMap<String, SkinMeta> = HashMap::new();
    let bdir = bundled_skins_dir(&app)?;
    if let Ok(entries) = std::fs::read_dir(&bdir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(m) = parse_skin(&entry.path()) {
                    map.insert(m.id.clone(), m);
                }
            }
        }
    }
    let udir = user_skins_dir()?;
    if let Ok(entries) = std::fs::read_dir(&udir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(m) = parse_skin(&entry.path()) {
                    map.entry(m.id.clone()).or_insert(m);
                }
            }
        }
    }
    let mut skins: Vec<SkinMeta> = map.into_values().collect();
    skins.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(skins)
}

/// 已读 asset 缓存: (skin_id, asset_name) → data URI / css 文本; 切换主题不重复读盘
static ASSET_CACHE: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
fn asset_cache() -> &'static Mutex<HashMap<(String, String), String>> {
    ASSET_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取皮肤资源: asset_name = "bg" (→ data URI) | "override" (→ css 原文)
#[tauri::command]
pub fn get_skin_asset(app: tauri::AppHandle, skin_id: String, asset_name: String) -> Result<String, String> {
    let key = (skin_id.clone(), asset_name.clone());
    if let Some(v) = asset_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(v);
    }
    let dir = find_skin_dir(&app, &skin_id)?;
    let cfg = read_config(&dir)?;
    let value = match asset_name.as_str() {
        "bg" => {
            let file = cfg.background.ok_or("皮肤未定义背景图")?;
            let data =
                std::fs::read(dir.join(&file)).map_err(|e| format!("读取背景图失败: {e}"))?;
            format!("data:{};base64,{}", mime_for(&file), BASE64.encode(data))
        }
        "override" => {
            let file = cfg.override_css.ok_or("皮肤未定义 override.css")?;
            std::fs::read_to_string(dir.join(&file))
                .map_err(|e| format!("读取 override.css 失败: {e}"))?
        }
        _ => return Err(format!("未知资源类型: {asset_name}")),
    };
    if let Ok(mut c) = asset_cache().lock() {
        c.insert(key, value.clone());
    }
    Ok(value)
}

/// 定位皮肤目录: 内置优先, 用户次之 (与 list_skins 的内置优先一致)
fn find_skin_dir(app: &tauri::AppHandle, skin_id: &str) -> Result<PathBuf, String> {
    let bundled = bundled_skins_dir(app)?.join(skin_id);
    if bundled.join("skin.json").exists() {
        return Ok(bundled);
    }
    let user = user_skins_dir()?.join(skin_id);
    if user.join("skin.json").exists() {
        return Ok(user);
    }
    Err(format!("皮肤不存在: {skin_id}"))
}

fn read_config(dir: &Path) -> Result<SkinConfig, String> {
    let text = std::fs::read_to_string(dir.join("skin.json"))
        .map_err(|e| format!("读取 skin.json 失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("skin.json 解析失败: {e}"))
}

/// 打开用户皮肤目录 (不存在则先创建), 供用户手动放置皮肤包
#[tauri::command]
pub fn open_skins_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = user_skins_dir()?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<String>)
        .map_err(|e| format!("打开皮肤目录失败: {e}"))
}

fn mime_for(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "css" => "text/css",
        _ => "image/png",
    }
}
