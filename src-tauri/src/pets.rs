// 桌宠注册器: 扫描内置 resources/pets/ (只读, 随应用分发) + 用户 ~/.pi-kitsune/pets/ (可写)
// 宠物包 = 一个目录: pet.json + 图片。两种格式:
//   v2 (format: 2): 命名动作库, 动作名 "类别.变体", 每个动作一条横条图 (导入器规整后帧尺寸统一)
//   v1 (无 format): Codex / hatch-pet 导出的 8×9 图集, 加载时按行号契约适配成 v2 动作, 不改写原文件
// 结构与 skins.rs 同构 — 两者都是「双源目录 + 元数据列表 + 二进制资产转 data URI」
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// 已知动作类别: 大脑只认这些。idle 必选, 其余缺了就退回 idle
pub const REQUIRED: &str = "idle";
pub const BASIC: [&str; 4] = ["walk", "work", "notify", "react"];
pub const FULL: [&str; 6] = ["slack", "sleep", "wait", "sad", "drag", "land"];
pub const PERSONALITIES: [&str; 4] = ["default", "diligent", "lazy", "playful"];
/// 台词上限: 气泡最多三行, 每组条数太多也没意义
pub const LINES_PER_GROUP: usize = 20;
pub const LINE_MAX_CHARS: usize = 40;
/// 只写 frames 不写定速时的默认帧率
const DEFAULT_FPS: f64 = 8.0;

/// 单个动作 (前端按 image/row 切帧, durations 逐帧定速)
#[derive(Serialize, Clone)]
pub struct PetAction {
    /// "类别.变体", 如 work.typing
    pub name: String,
    pub category: String,
    /// 素材键: 包目录内的相对路径, 交给 get_pet_asset
    pub image: String,
    /// 横条图恒为 0; v1 图集为行号
    pub row: u32,
    /// 逐帧毫秒, 长度即帧数
    pub durations: Vec<u32>,
    pub weight: f64,
    /// 最少 / 最多播几轮; None 交给大脑按类别兜底
    pub loops: Option<[u32; 2]>,
    pub interruptible: bool,
    /// 仅 walk: 逻辑像素/秒
    pub speed: Option<f64>,
    /// 仅 walk: 素材朝向 "left" / "right"
    pub facing: Option<String>,
}

/// 宠物元数据 (list_pets 返回给前端; 图片不随列表走, 单取 get_pet_asset)
#[derive(Serialize, Clone)]
pub struct PetMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub renderer: String,
    pub frame_width: u32,
    pub frame_height: u32,
    pub personality: String,
    pub lines: HashMap<String, Vec<String>>,
    pub actions: Vec<PetAction>,
    /// "required" | "basic" | "full": 满足到哪一档
    pub tier: String,
    /// 缺失的已知类别 (不含 idle)
    pub missing: Vec<String>,
    /// "v2" | "codex"
    pub source: String,
}

// ---------- v2 ----------

#[derive(Deserialize)]
struct FrameSize {
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
pub(crate) struct ActionV2 {
    pub file: String,
    pub frames: u32,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub durations: Option<Vec<u32>>,
    #[serde(default)]
    pub weight: Option<f64>,
    #[serde(default)]
    pub loops: Option<[u32; 2]>,
    #[serde(default)]
    pub interruptible: Option<bool>,
    #[serde(default)]
    pub speed: Option<f64>,
    #[serde(default)]
    pub facing: Option<String>,
}

#[derive(Deserialize)]
struct ManifestV2 {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    renderer: Option<String>,
    frame: FrameSize,
    #[serde(default)]
    personality: Option<String>,
    #[serde(default)]
    lines: HashMap<String, Vec<String>>,
    #[serde(default)]
    actions: HashMap<String, ActionV2>,
}

// ---------- v1 (Codex) ----------

/// v1 动画定义 (字段名沿用旧桌宠格式)
#[derive(Deserialize, Clone)]
struct AnimationV1 {
    row: u32,
    frames: u32,
    /// 一轮播完的总毫秒数 (非单帧时长)
    duration: u32,
}

#[derive(Deserialize)]
struct ManifestV1 {
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
    animations: HashMap<String, AnimationV1>,
}

fn default_spritesheet() -> String {
    "spritesheet.webp".to_string()
}

/// hatch-pet 的 8×9 图集行号契约 (见 hatch-pet references/animation-rows.md):
/// 行号 → (动作名, 朝向, 逐帧时长)。两只现存包的 pet.json 里动画名和行号对不上
/// (凛把第 6 行叫 writing, 实际画的是"等待"), 所以语义以行号为准, 不信 pet.json 里的名字
pub(crate) fn codex_rows() -> Vec<(u32, &'static str, Option<&'static str>, Vec<u32>)> {
    let rep = |ms: u32, n: usize, last: u32| {
        let mut v = vec![ms; n - 1];
        v.push(last);
        v
    };
    vec![
        (0, "idle.stand", None, vec![280, 110, 110, 140, 140, 320]),
        (1, "walk.run", Some("right"), rep(120, 8, 220)),
        (2, "walk.run-left", Some("left"), rep(120, 8, 220)),
        (3, "notify.wave", None, rep(140, 4, 280)),
        (4, "react.jump", None, rep(140, 5, 280)),
        (5, "sad.cry", None, rep(140, 8, 240)),
        (6, "wait.stand", None, rep(150, 6, 260)),
        (7, "work.busy", None, rep(120, 6, 220)),
        (8, "work.review", None, rep(150, 6, 280)),
    ]
}

/// 图集是否符合 8 列 × 9 行契约 (按帧尺寸核算)
pub(crate) fn is_codex_atlas(img_w: u32, img_h: u32, fw: u32, fh: u32) -> bool {
    img_w == fw * 8 && img_h == fh * 9
}

fn action(name: &str, image: &str, row: u32, durations: Vec<u32>, facing: Option<&str>) -> PetAction {
    PetAction {
        name: name.to_string(),
        category: category_of(name).to_string(),
        image: image.to_string(),
        row,
        durations,
        weight: 1.0,
        loops: None,
        interruptible: true,
        speed: None,
        facing: facing.map(str::to_string),
    }
}

pub(crate) fn category_of(name: &str) -> &str {
    name.split('.').next().unwrap_or(name)
}

/// 统一换算成逐帧时长: 显式 durations 优先, 其次 fps, 都没有按默认帧率
pub(crate) fn resolve_durations(a: &ActionV2) -> Option<Vec<u32>> {
    if a.frames == 0 {
        return None;
    }
    if let Some(d) = &a.durations {
        return (d.len() == a.frames as usize && d.iter().all(|&ms| ms > 0)).then(|| d.clone());
    }
    let fps = a.fps.filter(|f| *f > 0.0).unwrap_or(DEFAULT_FPS);
    Some(vec![(1000.0 / fps).round().max(1.0) as u32; a.frames as usize])
}

/// 台词按上限截断 (加载期静默截断, 导入期另行给警告)
pub(crate) fn clamp_lines(lines: HashMap<String, Vec<String>>) -> HashMap<String, Vec<String>> {
    lines
        .into_iter()
        .map(|(k, v)| {
            let v: Vec<String> = v
                .into_iter()
                .filter(|s| !s.trim().is_empty())
                .take(LINES_PER_GROUP)
                .map(|s| s.chars().take(LINE_MAX_CHARS).collect())
                .collect();
            (k, v)
        })
        .filter(|(_, v)| !v.is_empty())
        .collect()
}

/// 包内相对路径是否安全: 不许绝对路径、不许 .. 跳出包目录
pub(crate) fn safe_relative(p: &str) -> bool {
    let path = Path::new(p);
    !p.is_empty()
        && path
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// 按动作类别算档位与缺失类别 (加载器与导入器共用)
pub(crate) fn tier_of(categories: &[&str]) -> (String, Vec<String>) {
    let has = |c: &str| categories.contains(&c);
    let missing: Vec<String> = BASIC
        .iter()
        .chain(FULL.iter())
        .filter(|c| !has(c))
        .map(|c| c.to_string())
        .collect();
    let tier = if BASIC.iter().all(|c| has(c)) {
        if FULL.iter().all(|c| has(c)) {
            "full"
        } else {
            "basic"
        }
    } else {
        "required"
    };
    (tier.to_string(), missing)
}

/// 收尾: 校验 idle、动作排序、补档位与缺失类别、空名字回落到 id
fn finish(mut m: PetMeta) -> Option<PetMeta> {
    // idle 是兜底: 其余类别缺失时都退回它, 它自己缺了就无从回落, 整包判废
    if !m.actions.iter().any(|a| a.category == REQUIRED) {
        return None;
    }
    m.actions.sort_by(|a, b| a.name.cmp(&b.name));
    let cats: Vec<&str> = m.actions.iter().map(|a| a.category.as_str()).collect();
    (m.tier, m.missing) = tier_of(&cats);
    if m.name.trim().is_empty() {
        m.name = m.id.clone();
    }
    Some(m)
}

/// 解析单个宠物目录 → PetMeta; 读不到 / 解析失败 / 关键字段非法 / 没有 idle 时返回 None (跳过)。
/// 加载期宽松: 单个坏动作只丢掉它本身, 不连累整包; 严格校验是导入器的事
pub(crate) fn parse_pet(dir: &Path) -> Option<PetMeta> {
    let text = std::fs::read_to_string(dir.join("pet.json")).ok()?;
    let raw: serde_json::Value = serde_json::from_str(&text).ok()?;
    if raw.get("format").and_then(|v| v.as_u64()) == Some(2) {
        parse_v2(dir, raw)
    } else {
        parse_v1(dir, raw)
    }
}

fn parse_v2(dir: &Path, raw: serde_json::Value) -> Option<PetMeta> {
    let m: ManifestV2 = serde_json::from_value(raw).ok()?;
    if m.id.trim().is_empty() || m.frame.width == 0 || m.frame.height == 0 {
        return None;
    }
    // 只有帧动画渲染器; 未来的骨骼动画包在本版本里直接跳过, 不至于渲染出乱码
    if m.renderer.as_deref().is_some_and(|r| r != "frames") {
        return None;
    }
    let actions: Vec<PetAction> = m
        .actions
        .iter()
        .filter_map(|(name, a)| {
            if !safe_relative(&a.file) || !dir.join(&a.file).is_file() {
                return None;
            }
            let durations = resolve_durations(a)?;
            let facing = a.facing.clone().filter(|f| f == "left" || f == "right");
            Some(PetAction {
                name: name.clone(),
                category: category_of(name).to_string(),
                image: a.file.clone(),
                row: 0,
                durations,
                weight: a.weight.filter(|w| *w > 0.0).unwrap_or(1.0),
                loops: a.loops.filter(|[lo, hi]| *lo >= 1 && lo <= hi),
                interruptible: a.interruptible.unwrap_or(true),
                speed: a.speed.filter(|s| *s > 0.0),
                facing,
            })
        })
        .collect();
    let personality = m
        .personality
        .filter(|p| PERSONALITIES.contains(&p.as_str()))
        .unwrap_or_else(|| "default".to_string());
    finish(PetMeta {
        id: m.id,
        name: m.name,
        description: m.description,
        renderer: "frames".to_string(),
        frame_width: m.frame.width,
        frame_height: m.frame.height,
        personality,
        lines: clamp_lines(m.lines),
        actions,
        tier: String::new(),
        missing: Vec::new(),
        source: "v2".to_string(),
    })
}

fn parse_v1(dir: &Path, raw: serde_json::Value) -> Option<PetMeta> {
    let m: ManifestV1 = serde_json::from_value(raw).ok()?;
    if m.id.trim().is_empty() || m.frame_width == 0 || m.frame_height == 0 {
        return None;
    }
    if !safe_relative(&m.spritesheet_path) {
        return None;
    }
    let sheet = dir.join(&m.spritesheet_path);
    // 只读图片文件头拿尺寸, 不解码整张 2MB 级的图
    let (w, h) = image::image_dimensions(&sheet).ok()?;
    let img = m.spritesheet_path.as_str();
    let actions: Vec<PetAction> = if is_codex_atlas(w, h, m.frame_width, m.frame_height) {
        codex_rows()
            .into_iter()
            .map(|(row, name, facing, durations)| action(name, img, row, durations, facing))
            .collect()
    } else {
        // 不按 8×9 契约做的旧包: 按 pet.json 里的动画名尽力映射, 至少保证能以 idle 跑起来
        let rows = h / m.frame_height;
        let mut out: Vec<PetAction> = m
            .animations
            .iter()
            .filter(|(_, a)| a.frames > 0 && a.row < rows)
            .filter_map(|(key, a)| {
                let name = match key.as_str() {
                    "idle" => "idle.stand".to_string(),
                    "greet" => "notify.greet".to_string(),
                    "error" => "sad.error".to_string(),
                    // offline 与 error 在旧包里常是同一行, 留一个就够
                    "offline" => return None,
                    other => format!("work.{other}"),
                };
                let per = (a.duration / a.frames).max(1);
                Some(action(&name, img, a.row, vec![per; a.frames as usize], None))
            })
            .collect();
        out.dedup_by(|a, b| a.name == b.name);
        out
    };
    finish(PetMeta {
        id: m.id,
        name: m.display_name,
        description: m.description,
        renderer: "frames".to_string(),
        frame_width: m.frame_width,
        frame_height: m.frame_height,
        personality: "default".to_string(),
        lines: HashMap::new(),
        actions,
        tier: String::new(),
        missing: Vec::new(),
        source: "codex".to_string(),
    })
}

/// 用户宠物目录 ~/.pi-kitsune/pets (不存在则创建)
pub(crate) fn user_pets_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法确定用户主目录".to_string())?;
    let dir = PathBuf::from(home).join(".pi-kitsune").join("pets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建宠物目录失败: {e}"))?;
    Ok(dir)
}

/// 内置宠物目录: dev 模式 resource_dir=target/debug 且资源复制到 {rd}/resources/pets,
/// 打包后 Windows resource_dir=exe 目录, 资源同样在 {rd}/resources/pets — 取第一个存在的候选
pub(crate) fn bundled_pets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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

/// 已读图片缓存: "pet_id/相对路径" → data URI; 来回切角色不重复读盘 (单张 2MB 级)
static SPRITE_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
fn sprite_cache() -> &'static Mutex<HashMap<String, String>> {
    SPRITE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 导入覆盖某个包后要清掉它的旧图, 否则会继续显示旧精灵图
pub(crate) fn evict_sprites(pet_id: &str) {
    if let Ok(mut c) = sprite_cache().lock() {
        let prefix = format!("{pet_id}/");
        c.retain(|k, _| !k.starts_with(&prefix));
    }
}

/// 取宠物图片 → data URI。image 是 list_pets 给出的素材键 (包内相对路径)
#[tauri::command]
pub fn get_pet_asset(app: tauri::AppHandle, pet_id: String, image: String) -> Result<String, String> {
    // image 来自前端, 必须挡住 ../ 之类跳出包目录的路径
    if !safe_relative(&image) {
        return Err(format!("非法素材路径: {image}"));
    }
    let key = format!("{pet_id}/{image}");
    if let Some(v) = sprite_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(v);
    }
    let dir = find_pet_dir(&app, &pet_id)?;
    let data = std::fs::read(dir.join(&image)).map_err(|e| format!("读取宠物图片失败: {e}"))?;
    let value = format!("data:{};base64,{}", mime_for(&image), BASE64.encode(data));
    if let Ok(mut c) = sprite_cache().lock() {
        c.insert(key, value.clone());
    }
    Ok(value)
}

/// 定位宠物目录: 按 pet.json 里的 id 字段匹配, 不能假设目录名就是 id ——
/// codex 导出的包目录名常带后缀 (violet-evergarden-codex-pet 目录里 id 是 violet-evergarden),
/// 按目录名找会让 list_pets 列得出来、get_pet_asset 却取不到图。
/// 内置优先, 与 list_pets 的合并顺序保持一致
pub(crate) fn find_pet_dir(app: &tauri::AppHandle, pet_id: &str) -> Result<PathBuf, String> {
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
