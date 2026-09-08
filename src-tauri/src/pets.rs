// 桌宠注册器: 扫描内置 resources/pets/ (只读, 随应用分发) + 用户 ~/.pi-kitsune/pets/ (可写)
// 宠物包 = 一个目录: pet.json (元数据 + 帧尺寸 + 动画表) + spritesheet (行=状态, 列=帧)
// 结构与 skins.rs 同构 — 两者都是「双源目录 + 元数据列表 + 二进制资产转 data URI」
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// 单个状态的帧动画定义 (前端按 row/frames 切精灵图, 按 duration 定速)
#[derive(Deserialize, Serialize, Clone)]
pub struct PetAnimation {
    pub row: u32,
    pub frames: u32,
    /// 一轮播完的总毫秒数 (非单帧时长) — 前端除以 frames 得单帧间隔
    pub duration: u32,
    /// loop 是 Rust 关键字, rename 处理 (同 skins.rs 对 override 的手法)
    #[serde(default, rename = "loop")]
    pub loop_flag: bool,
}

/// 宠物元数据 (list_pets 返回给前端; 精灵图 2MB 级不随列表走, 单取 get_pet_asset)
#[derive(Serialize, Clone)]
pub struct PetMeta {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub frame_width: u32,
    pub frame_height: u32,
    /// 状态名 → 帧动画; 前端对缺失状态回落到 idle
    pub animations: HashMap<String, PetAnimation>,
    /// 可选编排: 状态名 → 依次轮播的动画名列表 (每播完一轮换下一个)。
    /// 让一个状态能有多个动作 (如 working = 书写 + 施法 交替), animations 结构本身不变;
    /// 没有这个字段的旧宠物包照常单动画播, 向后兼容
    pub state_sequences: HashMap<String, Vec<String>>,
}

/// pet.json 解析结构 (字段名沿用旧桌宠格式, 靠 rename 对齐 camelCase)
#[derive(Deserialize)]
struct PetConfig {
    id: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_spritesheet", rename = "spritesheetPath")]
    spritesheet_path: String,
    #[serde(rename = "frameWidth")]
    frame_width: u32,
    #[serde(rename = "frameHeight")]
    frame_height: u32,
    #[serde(default)]
    animations: HashMap<String, PetAnimation>,
    #[serde(default, rename = "stateSequences")]
    state_sequences: HashMap<String, Vec<String>>,
}

fn default_spritesheet() -> String {
    "spritesheet.webp".to_string()
}

/// 用户宠物目录 ~/.pi-kitsune/pets (不存在则创建)
fn user_pets_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法确定用户主目录".to_string())?;
    let dir = PathBuf::from(home).join(".pi-kitsune").join("pets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建宠物目录失败: {e}"))?;
    Ok(dir)
}

/// 内置宠物目录: dev 模式 resource_dir=target/debug 且资源复制到 {rd}/resources/pets,
/// 打包后 Windows resource_dir=exe 目录, 资源同样在 {rd}/resources/pets — 取第一个存在的候选
fn bundled_pets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let rd = app
        .path()
        .resource_dir()
        .map_err(|e| format!("定位内置宠物目录失败: {e}"))?;
    let candidates = [rd.join("resources").join("pets"), rd.join("pets")];
    for c in &candidates {
        if c.is_dir() {
            return Ok(c.clone());
        }
    }
    // 都不存在时返回第一个候选: 调用方 read_dir 失败跳过, 不影响用户宠物扫描
    Ok(candidates[0].clone())
}

/// 解析单个宠物目录 → PetMeta; 无有效 pet.json / id 空 / 帧尺寸为 0 / 缺 idle 动画时返回 None (跳过)
fn parse_pet(dir: &Path) -> Option<PetMeta> {
    let text = std::fs::read_to_string(dir.join("pet.json")).ok()?;
    let cfg: PetConfig = serde_json::from_str(&text).ok()?;
    if cfg.id.trim().is_empty() || cfg.frame_width == 0 || cfg.frame_height == 0 {
        return None;
    }
    // idle 是兜底状态: 其余状态缺失时前端回落到它, 它自己缺了就无从回落, 整包判废
    if !cfg.animations.contains_key("idle") {
        return None;
    }
    // 精灵图缺失的包进了列表也只会渲染出空白, 不如不列
    if !dir.join(&cfg.spritesheet_path).exists() {
        return None;
    }
    let display_name = if cfg.display_name.trim().is_empty() {
        cfg.id.clone()
    } else {
        cfg.display_name
    };
    // 序列里引用了不存在的动画名会让前端播不出东西, 这里就地过滤掉坏引用;
    // 过滤后为空的序列整条丢弃, 让该状态回落到同名单动画
    let animations = cfg.animations;
    let state_sequences: HashMap<String, Vec<String>> = cfg
        .state_sequences
        .into_iter()
        .map(|(state, names)| {
            let valid: Vec<String> = names
                .into_iter()
                .filter(|n| animations.contains_key(n))
                .collect();
            (state, valid)
        })
        .filter(|(_, names)| !names.is_empty())
        .collect();

    Some(PetMeta {
        id: cfg.id,
        display_name,
        description: cfg.description,
        frame_width: cfg.frame_width,
        frame_height: cfg.frame_height,
        animations,
        state_sequences,
    })
}

/// 合并两处宠物列表: id 冲突时内置优先 (与 list_skins 一致), 按 id 排序稳定展示
#[tauri::command]
pub fn list_pets(app: tauri::AppHandle) -> Result<Vec<PetMeta>, String> {
    let mut map: HashMap<String, PetMeta> = HashMap::new();
    let bdir = bundled_pets_dir(&app)?;
    if let Ok(entries) = std::fs::read_dir(&bdir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(m) = parse_pet(&entry.path()) {
                    map.insert(m.id.clone(), m);
                }
            }
        }
    }
    let udir = user_pets_dir()?;
    if let Ok(entries) = std::fs::read_dir(&udir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(m) = parse_pet(&entry.path()) {
                    map.entry(m.id.clone()).or_insert(m);
                }
            }
        }
    }
    let mut pets: Vec<PetMeta> = map.into_values().collect();
    pets.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(pets)
}

/// 已读精灵图缓存: pet_id → data URI; 来回切角色不重复读盘 (单张 2MB 级)
static SPRITE_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
fn sprite_cache() -> &'static Mutex<HashMap<String, String>> {
    SPRITE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取宠物精灵图 → data URI
#[tauri::command]
pub fn get_pet_asset(app: tauri::AppHandle, pet_id: String) -> Result<String, String> {
    if let Some(v) = sprite_cache().lock().ok().and_then(|c| c.get(&pet_id).cloned()) {
        return Ok(v);
    }
    let dir = find_pet_dir(&app, &pet_id)?;
    let text = std::fs::read_to_string(dir.join("pet.json"))
        .map_err(|e| format!("读取 pet.json 失败: {e}"))?;
    let cfg: PetConfig =
        serde_json::from_str(&text).map_err(|e| format!("pet.json 解析失败: {e}"))?;
    let data = std::fs::read(dir.join(&cfg.spritesheet_path))
        .map_err(|e| format!("读取精灵图失败: {e}"))?;
    let value = format!(
        "data:{};base64,{}",
        mime_for(&cfg.spritesheet_path),
        BASE64.encode(data)
    );
    if let Ok(mut c) = sprite_cache().lock() {
        c.insert(pet_id, value.clone());
    }
    Ok(value)
}

/// 定位宠物目录: 按 pet.json 里的 id 字段匹配, 不能假设目录名就是 id ——
/// codex 导出的包目录名常带后缀 (violet-evergarden-codex-pet 目录里 id 是 violet-evergarden),
/// 按目录名找会让 list_pets 列得出来、get_pet_asset 却取不到图。
/// 内置优先, 与 list_pets 的合并顺序保持一致
fn find_pet_dir(app: &tauri::AppHandle, pet_id: &str) -> Result<PathBuf, String> {
    for base in [bundled_pets_dir(app)?, user_pets_dir()?] {
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if dir.is_dir() && parse_pet(&dir).is_some_and(|m| m.id == pet_id) {
                    return Ok(dir);
                }
            }
        }
    }
    Err(format!("宠物不存在: {pet_id}"))
}

/// 打开用户宠物目录 (不存在则先创建), 供用户手动放置宠物包
#[tauri::command]
pub fn open_pets_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = user_pets_dir()?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<String>)
        .map_err(|e| format!("打开宠物目录失败: {e}"))
}

fn mime_for(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        _ => "image/png",
    }
}
