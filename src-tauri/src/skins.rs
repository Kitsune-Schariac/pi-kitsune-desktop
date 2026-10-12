// 皮肤注册器: 扫描内置 resources/skins/ (只读, 随应用分发) + 用户 ~/.pi-kitsune/skins/ (可写)
// 皮肤包 = 一个目录: skin.json (元数据 + 色阶) + 可选 override.css; 只有纯色主题, 不再支持壁纸
// (旧皮肤包里的 background / bubble 字段由 serde 忽略未知字段兜住, 照常按配色加载)
// 预览不读图: 前端按 colors 画骨架缩略图
// 契约与前端 ThemeStore 对齐, 见 .trellis/tasks/08-10-theme-skin-system/design.md
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// 皮肤元数据 (list_skins 返回给前端; override.css 走 get_skin_asset)
#[derive(Serialize, Clone)]
pub struct SkinMeta {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    /// "light" | "dark", 驱动中性色阶方向 + Shiki 主题 + markdown 文字色
    pub base: String,
    /// 任意 CSS 颜色值 (oklch / hex / color-mix / 旧 RGB 通道三段数字), 前端写 :root 变量;
    /// 旧格式三段数字在加载时包成 rgb() 以兼容存量皮肤包 (值格式嗅探, 见 normalize_color)
    pub colors: HashMap<String, String>,
    pub has_override: bool,
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
    #[serde(default, rename = "override")]
    override_css: Option<String>,
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

/// 旧版颜色格式 (RGB 通道 "r g b") → 包成 rgb() 透传; 新格式 (oklch/hex/color-mix 等) 原样返回。
/// 嗅探规则: 恰好三段 1-3 位数字、空白分隔 → 视为旧 RGB 通道 (合法 CSS 颜色值不会是这个形态);
/// 不加版本字段 — 嗅探对皮肤包作者完全透明, 存量第三方包零改动继续工作
fn normalize_color(v: &str) -> String {
    let parts: Vec<&str> = v.split_whitespace().collect();
    let is_legacy_rgb = parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit())
        });
    if is_legacy_rgb {
        format!("rgb({})", v.trim())
    } else {
        v.to_string()
    }
}

/// 解析单个皮肤目录 → SkinMeta; 目录无有效 skin.json 或 base 非法时返回 None (跳过)
fn parse_skin(dir: &Path) -> Option<SkinMeta> {
    let text = std::fs::read_to_string(dir.join("skin.json")).ok()?;
    let cfg: SkinConfig = serde_json::from_str(&text).ok()?;
    if cfg.id.trim().is_empty() || (cfg.base != "light" && cfg.base != "dark") {
        return None;
    }
    let colors: HashMap<String, String> = cfg
        .colors
        .into_iter()
        .map(|(k, v)| (k, normalize_color(&v)))
        .collect();
    Some(SkinMeta {
        id: cfg.id,
        name: cfg.name,
        author: cfg.author,
        version: cfg.version,
        base: cfg.base,
        colors,
        has_override: cfg.override_css.as_ref().is_some_and(|n| dir.join(n).exists()),
    })
}

/// 合并两处皮肤列表: id 冲突时内置优先 (用户皮肤被覆盖); 亮色在前、同方向按 id 排序稳定展示
#[tauri::command]
pub fn list_skins(app: tauri::AppHandle) -> Result<Vec<SkinMeta>, String> {
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
    skins.sort_by(|a, b| (a.base != "light", &a.id).cmp(&(b.base != "light", &b.id)));
    Ok(skins)
}

/// 已读 asset 缓存: (skin_id, asset_name) → css 文本; 切换主题不重复读盘
static ASSET_CACHE: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
fn asset_cache() -> &'static Mutex<HashMap<(String, String), String>> {
    ASSET_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取皮肤资源: asset_name 目前只有 "override" (→ css 原文)
#[tauri::command]
pub fn get_skin_asset(app: tauri::AppHandle, skin_id: String, asset_name: String) -> Result<String, String> {
    let key = (skin_id.clone(), asset_name.clone());
    if let Some(v) = asset_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(v);
    }
    let dir = find_skin_dir(&app, &skin_id)?;
    let cfg = read_config(&dir)?;
    let value = match asset_name.as_str() {
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
