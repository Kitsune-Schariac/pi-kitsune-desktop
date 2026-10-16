// 宠物包导入: 解包 → 切帧 → 对齐 → 校验 → 预览 → 落盘
//
// 素材以 AI 生成为主, 而 AI 出的帧动画常见毛病是帧与帧之间位置漂移 (脚底高低不一、左右偏)、
// 帧宽不匀。所以导入不是复制文件, 而是一条规整流水线: 作者丢进来不太规整的横条图,
// 这里切帧、按脚底对齐、统一成 frame 尺寸, 再打包成标准 v2 包。旧 Codex 图集也走同一条路。
//
// 两步命令: inspect 把规整结果放进缓存目录并回报 (错误 / 警告 / 预览), 用户确认后 commit 落盘;
// 中间结果按 token 存在 app_cache_dir/pet-import/<token>/, discard 或 commit 后清掉。
use crate::pets::{self, ActionV2};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{Rgba, RgbaImage};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// alpha 超过它才算"有内容"的像素: 抗锯齿留下的半透明毛边不该撑大包围盒
const ALPHA_MIN: u8 = 16;
/// 解包安全限制: 总解压体积、条目数、单张图边长
const MAX_UNZIPPED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 512;
const MAX_IMAGE_SIDE: u32 = 8192;
/// 同一条横条图里各帧底边的极差不超过格高的这个比例, 视为生成漂移, 逐帧拉齐;
/// 超过就当是有意的纵向动作 (跳跃、落地), 整条统一平移、保留帧间高度差
const DRIFT_RATIO: f64 = 0.06;
/// 脚底离格子底边的留白 (像素)
const FOOT_MARGIN: u32 = 4;
/// 角色高度与 idle 相差超过这个比例给警告。只比较站姿类动作, 蹲 / 睡 / 跳本来就该矮或高
const HEIGHT_TOLERANCE: f64 = 0.15;
const HEIGHT_CHECKED: [&str; 4] = ["walk", "work", "notify", "wait"];
/// 超过这么久的导入缓存视为被遗弃 (用户关了面板却没走到 discard, 比如中途崩溃), 下次导入时清掉
const STALE_STAGING: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

#[derive(Serialize, Clone)]
pub struct Issue {
    pub action: Option<String>,
    pub file: Option<String>,
    pub message: String,
}

#[derive(Serialize)]
pub struct Preview {
    pub action: String,
    /// 规整后的横条图 (PNG data URI), 帧宽 = frame_width
    pub data_uri: String,
    pub durations: Vec<u32>,
}

#[derive(Serialize)]
pub struct ImportReport {
    pub token: String,
    pub id: String,
    pub name: String,
    pub frame_width: u32,
    pub frame_height: u32,
    /// 用户目录里已有同 id 的包 (commit 需要 overwrite)
    pub exists: bool,
    /// 将被覆盖的目录, 给前端在确认框里展示
    pub existing_dir: Option<String>,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
    pub tier: String,
    pub missing: Vec<String>,
    pub previews: Vec<Preview>,
}

/// 有错误的导入在缓存里留这个标记, commit 据此拒绝 (前端按钮会禁用, 这里是兜底)
const BLOCKED_MARK: &str = "BLOCKED";

/// 收集问题的小账本, 让切帧 / 对齐各步只管往里记
#[derive(Default)]
struct Issues {
    errors: Vec<Issue>,
    warnings: Vec<Issue>,
}

impl Issues {
    fn error(&mut self, action: Option<&str>, file: Option<&str>, message: String) {
        self.errors.push(Issue { action: action.map(str::to_string), file: file.map(str::to_string), message });
    }
    fn warn(&mut self, action: Option<&str>, file: Option<&str>, message: String) {
        self.warnings.push(Issue { action: action.map(str::to_string), file: file.map(str::to_string), message });
    }
}

/// 规整中的一个动作: 输出到 out/actions/<name>.png 的横条图 + 写进 pet.json 的字段
struct NormalizedAction {
    name: String,
    strip: RgbaImage,
    durations: Vec<u32>,
    extra: serde_json::Map<String, serde_json::Value>,
    /// 各帧内容高度的中位数, 给"与 idle 比高矮"的检查用
    body_height: u32,
}

/// 切出来的一帧: 只含这一帧像素的裁剪图, 以及它在原图里的顶边位置
/// (水平位置用不上: 水平按中位 x 对齐; 垂直在"整条平移"模式下要保留各帧原有的高低)
struct Frame {
    img: RgbaImage,
    oy: i64,
}

fn staging_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("定位缓存目录失败: {e}"))?
        .join("pet-import");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建导入缓存目录失败: {e}"))?;
    Ok(dir)
}

fn sweep_stale(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let stale = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STALE_STAGING);
        if stale {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn staging_dir(app: &tauri::AppHandle, token: &str) -> Result<PathBuf, String> {
    // token 由 inspect 生成, 只有十六进制; 前端传回时也要挡一下, 免得被拼成任意路径
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("导入凭据无效".to_string());
    }
    Ok(staging_root(app)?.join(token))
}

#[tauri::command]
pub fn inspect_pet_import(app: tauri::AppHandle, path: String) -> Result<ImportReport, String> {
    let token = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    sweep_stale(&staging_root(&app)?);
    let stage = staging_dir(&app, &token)?;
    let result = inspect_into(&app, Path::new(&path), &stage, token);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    result
}

fn inspect_into(app: &tauri::AppHandle, input: &Path, stage: &Path, token: String) -> Result<ImportReport, String> {
    let mut issues = Issues::default();
    let src_root = if input.is_dir() {
        input.to_path_buf()
    } else if input.is_file() {
        let dest = stage.join("src");
        let ignored = unzip(input, &dest)?;
        if ignored > 0 {
            issues.warn(None, None, format!("忽略了 {ignored} 个非 json / 图片文件"));
        }
        dest
    } else {
        return Err(format!("找不到要导入的文件或目录: {}", input.display()));
    };
    let pack = locate_pack_root(&src_root)?;
    let text = std::fs::read_to_string(pack.join("pet.json")).map_err(|e| format!("读取 pet.json 失败: {e}"))?;
    let raw: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("pet.json 不是合法 JSON: {e}"))?;

    let manifest = if raw.get("format").and_then(|v| v.as_u64()) == Some(2) {
        normalize_v2(&pack, &raw, &mut issues)?
    } else {
        normalize_v1(&pack, &raw, &mut issues)?
    };

    let id = manifest.id.clone();
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        issues.error(None, Some("pet.json"), format!("id \"{id}\" 不合法: 只能用小写字母、数字和连字符, 1~64 个字符"));
    }
    if !manifest.actions.iter().any(|a| pets::category_of(&a.name) == pets::REQUIRED) {
        issues.error(None, Some("pet.json"), "缺少必选的 idle 类动作 (如 idle.stand)".to_string());
    }
    check_heights(&manifest.actions, &mut issues);

    // 内置包同 id 时导入了也看不见 (list_pets 内置优先), 直接报错比静默失效好
    let bundled = pets::bundled_pets_dir(app)?;
    if find_by_id(&bundled, &id).is_some() {
        issues.error(None, None, format!("和内置宠物包的 id \"{id}\" 冲突, 请改个 id"));
    }
    let existing = find_by_id(&pets::user_pets_dir()?, &id);

    // 写出规整结果 (有错误也写, 预览要用; commit 时会再拒绝)
    let out = stage.join("out");
    std::fs::create_dir_all(out.join("actions")).map_err(|e| format!("创建导入缓存失败: {e}"))?;
    let mut previews = Vec::new();
    for a in &manifest.actions {
        let file = out.join("actions").join(format!("{}.png", a.name));
        a.strip.save(&file).map_err(|e| format!("写出 {} 失败: {e}", a.name))?;
        let bytes = std::fs::read(&file).map_err(|e| format!("读回 {} 失败: {e}", a.name))?;
        previews.push(Preview {
            action: a.name.clone(),
            data_uri: format!("data:image/png;base64,{}", BASE64.encode(bytes)),
            durations: a.durations.clone(),
        });
    }
    let json = manifest.to_json();
    std::fs::write(
        out.join("pet.json"),
        serde_json::to_string_pretty(&json).map_err(|e| format!("生成 pet.json 失败: {e}"))?,
    )
    .map_err(|e| format!("写出 pet.json 失败: {e}"))?;

    if !issues.errors.is_empty() {
        std::fs::write(stage.join(BLOCKED_MARK), "").map_err(|e| format!("写导入缓存失败: {e}"))?;
    }
    let cats: Vec<&str> = manifest.actions.iter().map(|a| pets::category_of(&a.name)).collect();
    let (tier, missing) = pets::tier_of(&cats);
    Ok(ImportReport {
        token,
        id,
        name: manifest.name,
        frame_width: manifest.fw,
        frame_height: manifest.fh,
        exists: existing.is_some(),
        existing_dir: existing.map(|d| d.to_string_lossy().into_owned()),
        errors: issues.errors,
        warnings: issues.warnings,
        tier,
        missing,
        previews,
    })
}

/// 解 zip 到 dest, 返回忽略掉的文件数。enclosed_name 挡掉 ../ 与绝对路径 (zip slip)
fn unzip(file: &Path, dest: &Path) -> Result<usize, String> {
    let f = std::fs::File::open(file).map_err(|e| format!("打开 {} 失败: {e}", file.display()))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("不是有效的 zip 文件: {e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(format!("zip 里文件太多 ({} 个), 上限 {MAX_ENTRIES}", zip.len()));
    }
    let mut total = 0u64;
    let mut ignored = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("读取 zip 条目失败: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(rel) = entry.enclosed_name() else {
            let shown = entry.name().map(|n| n.into_owned()).unwrap_or_default();
            return Err(format!("zip 里有不安全的路径: {shown}"));
        };
        let ext = rel.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "json" | "png" | "webp" | "jpg" | "jpeg") {
            ignored += 1;
            continue;
        }
        // 声明大小可以造假, 按实际读出的字节数累计, 超限立刻停
        let mut buf = Vec::new();
        let limit = MAX_UNZIPPED_BYTES.saturating_sub(total) + 1;
        (&mut entry)
            .take(limit)
            .read_to_end(&mut buf)
            .map_err(|e| format!("解压 {} 失败: {e}", rel.display()))?;
        total += buf.len() as u64;
        if total > MAX_UNZIPPED_BYTES {
            return Err(format!("zip 解压后超过 {} MB", MAX_UNZIPPED_BYTES / 1024 / 1024));
        }
        let target = dest.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        std::fs::write(&target, buf).map_err(|e| format!("写出 {} 失败: {e}", rel.display()))?;
    }
    Ok(ignored)
}

/// pet.json 可以在根目录, 也可以在唯一的一层子目录里 (兼容"把整个文件夹压缩"的情况)
fn locate_pack_root(root: &Path) -> Result<PathBuf, String> {
    if root.join("pet.json").is_file() {
        return Ok(root.to_path_buf());
    }
    let dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .map_err(|e| format!("读取目录失败: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    match dirs.as_slice() {
        [only] if only.join("pet.json").is_file() => Ok(only.clone()),
        _ => Err("没有找到 pet.json (应在根目录或唯一的一层子目录里)".to_string()),
    }
}

fn find_by_id(base: &Path, id: &str) -> Option<PathBuf> {
    std::fs::read_dir(base).ok()?.flatten().map(|e| e.path()).find(|d| {
        d.is_dir()
            && !d.extension().is_some_and(|e| e == "bak" || e == "importing")
            && pets::parse_pet(d).is_some_and(|m| m.id == id)
    })
}

/// 规整后的整包
struct Manifest {
    id: String,
    name: String,
    description: String,
    fw: u32,
    fh: u32,
    personality: String,
    lines: HashMap<String, Vec<String>>,
    actions: Vec<NormalizedAction>,
}

impl Manifest {
    fn to_json(&self) -> serde_json::Value {
        let mut actions = serde_json::Map::new();
        for a in &self.actions {
            let mut obj = a.extra.clone();
            obj.insert("file".into(), format!("actions/{}.png", a.name).into());
            obj.insert("frames".into(), (a.durations.len() as u64).into());
            obj.insert("durations".into(), serde_json::json!(a.durations));
            actions.insert(a.name.clone(), obj.into());
        }
        serde_json::json!({
            "format": 2,
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "renderer": "frames",
            "frame": { "width": self.fw, "height": self.fh },
            "personality": self.personality,
            "lines": self.lines,
            "actions": actions,
        })
    }
}

fn normalize_v2(pack: &Path, raw: &serde_json::Value, issues: &mut Issues) -> Result<Manifest, String> {
    let s = |k: &str| raw.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let renderer = raw.get("renderer").and_then(|v| v.as_str()).unwrap_or("frames");
    if renderer != "frames" {
        issues.error(None, Some("pet.json"), format!("不支持的渲染器 \"{renderer}\", 本版本只支持 frames"));
    }
    let fw = raw.pointer("/frame/width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let fh = raw.pointer("/frame/height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if fw == 0 || fh == 0 {
        return Err("pet.json 缺少有效的 frame.width / frame.height".to_string());
    }
    let personality = match raw.get("personality").and_then(|v| v.as_str()) {
        None => "default".to_string(),
        Some(p) if pets::PERSONALITIES.contains(&p) => p.to_string(),
        Some(p) => {
            issues.warn(None, Some("pet.json"), format!("未知的性格 \"{p}\", 按 default 处理"));
            "default".to_string()
        }
    };
    let lines = read_lines(raw, issues);

    let mut actions = Vec::new();
    // BTreeMap 让导入报告与输出顺序稳定
    let defs: BTreeMap<String, serde_json::Value> = raw
        .get("actions")
        .and_then(|v| v.as_object())
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    for (name, def) in defs {
        let cat = pets::category_of(&name);
        if !is_known(cat) {
            issues.warn(Some(&name), None, format!("未知类别 \"{cat}\", 会被保留但大脑不会使用它"));
        }
        if !valid_action_name(&name) {
            issues.error(Some(&name), None, "动作名只能用小写字母、数字、连字符, 格式为 类别.变体".to_string());
            continue;
        }
        let a: ActionV2 = match serde_json::from_value(def.clone()) {
            Ok(a) => a,
            Err(e) => {
                issues.error(Some(&name), None, format!("动作定义不合法: {e}"));
                continue;
            }
        };
        let Some(durations) = pets::resolve_durations(&a) else {
            issues.error(
                Some(&name),
                None,
                format!("帧数 {} 与 durations 长度不符, 或帧数 / 时长为 0", a.frames),
            );
            continue;
        };
        if !pets::safe_relative(&a.file) {
            issues.error(Some(&name), Some(&a.file), "图片路径不能是绝对路径或跳出包目录".to_string());
            continue;
        }
        let Some(img) = load_rgba(&pack.join(&a.file), &name, &a.file, issues) else {
            continue;
        };
        let frames = match slice_components(&img, a.frames as usize) {
            Some(f) => f,
            None => {
                issues.warn(
                    Some(&name),
                    Some(&a.file),
                    format!("按透明间隙切不出 {} 帧 (帧与帧可能粘连), 改为按宽度均分", a.frames),
                );
                let Some(f) = slice_grid(&img, a.frames, img.width() / a.frames.max(1), img.height(), 0, &name, issues)
                else {
                    continue;
                };
                f
            }
        };
        if let Some(n) = align(&frames, fw, fh, &name, &a.file, issues) {
            actions.push(NormalizedAction {
                name: name.clone(),
                strip: n.0,
                durations,
                extra: carry_fields(&def),
                body_height: n.1,
            });
        }
    }
    Ok(Manifest {
        id: s("id"),
        name: s("name"),
        description: s("description"),
        fw,
        fh,
        personality,
        lines,
        actions,
    })
}

/// v1 (Codex 图集) 导入时转成 v2: 按行号契约把每行切成横条图再走同样的对齐, 这样也能去抖
fn normalize_v1(pack: &Path, raw: &serde_json::Value, issues: &mut Issues) -> Result<Manifest, String> {
    let s = |k: &str| raw.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let fw = raw.get("frameWidth").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let fh = raw.get("frameHeight").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if fw == 0 || fh == 0 {
        return Err("旧格式 pet.json 缺少有效的 frameWidth / frameHeight".to_string());
    }
    let sheet = raw.get("spritesheetPath").and_then(|v| v.as_str()).unwrap_or("spritesheet.webp").to_string();
    if !pets::safe_relative(&sheet) {
        return Err("spritesheetPath 不能是绝对路径或跳出包目录".to_string());
    }
    let img = load_rgba(&pack.join(&sheet), "图集", &sheet, issues).ok_or("图集读取失败, 详见错误列表")?;

    // 行号 → (动作名, 帧数, 逐帧时长, 朝向)
    let rows: Vec<(u32, String, Vec<u32>, Option<&str>)> = if pets::is_codex_atlas(img.width(), img.height(), fw, fh) {
        pets::codex_rows().into_iter().map(|(r, n, facing, d)| (r, n.to_string(), d, facing)).collect()
    } else {
        issues.warn(None, Some(&sheet), "图集不是 8×9 的 Codex 契约, 按 pet.json 里的动画名尽力映射".to_string());
        let mut out = Vec::new();
        if let Some(anims) = raw.get("animations").and_then(|v| v.as_object()) {
            for (key, a) in anims {
                let row = a.get("row").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let frames = a.get("frames").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let total = a.get("duration").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if frames == 0 || (row + 1) * fh > img.height() {
                    continue;
                }
                let name = match key.as_str() {
                    "idle" => "idle.stand".to_string(),
                    "greet" => "notify.greet".to_string(),
                    "error" => "sad.error".to_string(),
                    "offline" => continue,
                    other => format!("work.{}", other.to_ascii_lowercase()),
                };
                out.push((row, name, vec![(total / frames).max(1); frames as usize], None));
            }
        }
        out
    };

    let mut actions = Vec::new();
    for (row, name, durations, facing) in rows {
        let Some(frames) = slice_grid(&img, durations.len() as u32, fw, fh, row * fh, &name, issues) else {
            continue;
        };
        if let Some(n) = align(&frames, fw, fh, &name, &sheet, issues) {
            let mut extra = serde_json::Map::new();
            if let Some(f) = facing {
                extra.insert("facing".into(), f.into());
            }
            actions.push(NormalizedAction { name, strip: n.0, durations, extra, body_height: n.1 });
        }
    }
    Ok(Manifest {
        id: s("id"),
        name: s("displayName"),
        description: s("description"),
        fw,
        fh,
        personality: "default".to_string(),
        lines: HashMap::new(),
        actions,
    })
}

fn is_known(cat: &str) -> bool {
    cat == pets::REQUIRED || pets::BASIC.contains(&cat) || pets::FULL.contains(&cat)
}

/// 动作名会变成输出文件名, 只放行安全字符
fn valid_action_name(name: &str) -> bool {
    let mut parts = name.splitn(2, '.');
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    matches!((parts.next(), parts.next()), (Some(a), Some(b)) if ok(a) && ok(b))
}

/// 原样带进输出 pet.json 的调度字段 (帧来源和定速由规整结果重写)
fn carry_fields(def: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    for k in ["weight", "loops", "interruptible", "speed", "facing"] {
        if let Some(v) = def.get(k) {
            out.insert(k.into(), v.clone());
        }
    }
    out
}

fn read_lines(raw: &serde_json::Value, issues: &mut Issues) -> HashMap<String, Vec<String>> {
    let mut lines: HashMap<String, Vec<String>> = HashMap::new();
    let Some(obj) = raw.get("lines").and_then(|v| v.as_object()) else {
        return lines;
    };
    for (k, v) in obj {
        let list: Vec<String> = v
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        if list.len() > pets::LINES_PER_GROUP || list.iter().any(|l| l.chars().count() > pets::LINE_MAX_CHARS) {
            issues.warn(
                None,
                Some("pet.json"),
                format!(
                    "台词组 \"{k}\" 超出上限 (每组 {} 条、每条 {} 字), 已截断",
                    pets::LINES_PER_GROUP,
                    pets::LINE_MAX_CHARS
                ),
            );
        }
        lines.insert(k.clone(), list);
    }
    pets::clamp_lines(lines)
}

fn load_rgba(path: &Path, action: &str, file: &str, issues: &mut Issues) -> Option<RgbaImage> {
    if !path.is_file() {
        issues.error(Some(action), Some(file), "图片文件不存在".to_string());
        return None;
    }
    let img = match image::open(path) {
        Ok(i) => i,
        Err(e) => {
            issues.error(Some(action), Some(file), format!("图片读取失败: {e}"));
            return None;
        }
    };
    if img.width() > MAX_IMAGE_SIDE || img.height() > MAX_IMAGE_SIDE {
        issues.error(Some(action), Some(file), format!("图片边长超过 {MAX_IMAGE_SIDE}"));
        return None;
    }
    // 没有透明通道就没法区分角色和背景; 抠图是生成工具的事, 这里不猜
    if !img.color().has_alpha() {
        issues.error(Some(action), Some(file), "图片没有透明通道, 请先去掉背景再导入".to_string());
        return None;
    }
    Some(img.to_rgba8())
}

fn opaque(p: &Rgba<u8>) -> bool {
    p[3] > ALPHA_MIN
}

/// 按连通域切帧 (沿用 hatch-pet extract_component_frames 的做法): 大块作种子, 碎片归到最近的种子。
/// 切不出 n 个种子返回 None, 由调用方退回均分
fn slice_components(img: &RgbaImage, n: usize) -> Option<Vec<Frame>> {
    if n == 0 {
        return None;
    }
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut label = vec![0u32; w * h];
    // (面积, min_x, min_y, max_x, max_y, x 坐标和)
    let mut comps: Vec<(usize, usize, usize, usize, usize, usize)> = Vec::new();
    let mut stack = Vec::new();
    for start in 0..w * h {
        if label[start] != 0 || !opaque(img.get_pixel((start % w) as u32, (start / w) as u32)) {
            continue;
        }
        let id = comps.len() as u32 + 1;
        let mut c = (0, usize::MAX, usize::MAX, 0, 0, 0);
        label[start] = id;
        stack.push(start);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            c.0 += 1;
            c.1 = c.1.min(x);
            c.2 = c.2.min(y);
            c.3 = c.3.max(x);
            c.4 = c.4.max(y);
            c.5 += x;
            let mut visit = |j: usize| {
                if label[j] == 0 && opaque(img.get_pixel((j % w) as u32, (j / w) as u32)) {
                    label[j] = id;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(i - 1);
            }
            if x + 1 < w {
                visit(i + 1);
            }
            if y > 0 {
                visit(i - w);
            }
            if y + 1 < h {
                visit(i + w);
            }
        }
        comps.push(c);
    }
    let largest = comps.iter().map(|c| c.0).max()?;
    let seed_min = (largest as f64 * 0.2).max(120.0) as usize;
    let mut seeds: Vec<usize> = (0..comps.len()).filter(|&i| comps[i].0 >= seed_min).collect();
    if seeds.len() < n {
        seeds = (0..comps.len()).collect();
    }
    if seeds.len() < n {
        return None;
    }
    seeds.sort_by(|a, b| comps[*b].0.cmp(&comps[*a].0));
    seeds.truncate(n);
    let cx = |i: usize| comps[i].5 as f64 / comps[i].0 as f64;
    seeds.sort_by(|a, b| cx(*a).total_cmp(&cx(*b)));
    // 每个连通域归属到哪一帧: 种子是自己, 其余 (噪点太小的丢弃) 归到中心 x 最近的种子
    let noise = (largest as f64 * 0.002).max(12.0) as usize;
    let mut owner = vec![usize::MAX; comps.len()];
    for (k, &s) in seeds.iter().enumerate() {
        owner[s] = k;
    }
    for i in 0..comps.len() {
        if owner[i] != usize::MAX || comps[i].0 < noise {
            continue;
        }
        owner[i] = (0..n)
            .min_by(|&a, &b| (cx(seeds[a]) - cx(i)).abs().total_cmp(&(cx(seeds[b]) - cx(i)).abs()))
            .unwrap_or(0);
    }
    let mut frames = Vec::with_capacity(n);
    for k in 0..n {
        let members: Vec<usize> = (0..comps.len()).filter(|&i| owner[i] == k).collect();
        let x0 = members.iter().map(|&i| comps[i].1).min()?;
        let y0 = members.iter().map(|&i| comps[i].2).min()?;
        let x1 = members.iter().map(|&i| comps[i].3).max()?;
        let y1 = members.iter().map(|&i| comps[i].4).max()?;
        let mut crop = RgbaImage::new((x1 - x0 + 1) as u32, (y1 - y0 + 1) as u32);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let l = label[y * w + x];
                // 只拷属于这一帧的像素: 相邻帧的头发尖伸进包围盒也不会被带过来
                if l != 0 && owner[(l - 1) as usize] == k {
                    crop.put_pixel((x - x0) as u32, (y - y0) as u32, *img.get_pixel(x as u32, y as u32));
                }
            }
        }
        frames.push(Frame { img: crop, oy: y0 as i64 });
    }
    Some(frames)
}

/// 按固定格子切: 第 k 帧取 (k*cw, top) 起 cw×ch 的区域, 裁到内容包围盒。空格子报错
fn slice_grid(img: &RgbaImage, n: u32, cw: u32, ch: u32, top: u32, action: &str, issues: &mut Issues) -> Option<Vec<Frame>> {
    let mut frames = Vec::with_capacity(n as usize);
    for k in 0..n {
        let (rx, ry) = (k * cw, top);
        let (rw, rh) = (cw.min(img.width().saturating_sub(rx)), ch.min(img.height().saturating_sub(ry)));
        let mut bbox: Option<(u32, u32, u32, u32)> = None;
        for y in ry..ry + rh {
            for x in rx..rx + rw {
                if opaque(img.get_pixel(x, y)) {
                    bbox = Some(match bbox {
                        None => (x, y, x, y),
                        Some((a, b, c, d)) => (a.min(x), b.min(y), c.max(x), d.max(y)),
                    });
                }
            }
        }
        let Some((x0, y0, x1, y1)) = bbox else {
            issues.error(Some(action), None, format!("第 {} 帧是空的 (整格透明)", k + 1));
            return None;
        };
        let crop = image::imageops::crop_imm(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image();
        frames.push(Frame { img: crop, oy: y0 as i64 });
    }
    Some(frames)
}

/// 不透明像素 x 坐标的中位数: 抬手、甩头发会把包围盒中心带偏, 中位数不会
fn median_x(img: &RgbaImage) -> f64 {
    let mut cols = vec![0usize; img.width() as usize];
    let mut total = 0;
    for (x, _, p) in img.enumerate_pixels() {
        if opaque(p) {
            cols[x as usize] += 1;
            total += 1;
        }
    }
    let mut acc = 0;
    for (x, c) in cols.iter().enumerate() {
        acc += c;
        if acc * 2 >= total {
            return x as f64 + 0.5;
        }
    }
    img.width() as f64 / 2.0
}

/// 把各帧放进 fw×fh 的格子拼成横条图, 返回 (横条图, 帧高中位数)。
/// 水平: 中位 x 对齐格子中线。垂直: 底边极差小 → 逐帧拉齐到留白线; 大 → 整条统一平移 (保留跳跃)
fn align(frames: &[Frame], fw: u32, fh: u32, action: &str, file: &str, issues: &mut Issues) -> Option<(RgbaImage, u32)> {
    if frames.is_empty() {
        return None;
    }
    let baseline = fh.saturating_sub(FOOT_MARGIN) as i64;
    let bottoms: Vec<i64> = frames.iter().map(|f| f.oy + f.img.height() as i64).collect();
    let max_bottom = *bottoms.iter().max()?;
    let min_bottom = *bottoms.iter().min()?;
    let per_frame = (max_bottom - min_bottom) as f64 <= fh as f64 * DRIFT_RATIO;

    let mut strip = RgbaImage::new(fw * frames.len() as u32, fh);
    let mut ok = true;
    for (k, f) in frames.iter().enumerate() {
        let (w, h) = (f.img.width() as i64, f.img.height() as i64);
        // 只有内容本身比格子大才算错; 尺寸放得下、只是按中位数居中后蹭出边的 (蹲坐时头发散向一侧
        // 之类重心偏的姿势), 推回格子里贴边即可 —— 正版 Codex 图集里就有这种帧
        if w > fw as i64 || h > fh as i64 {
            issues.error(
                Some(action),
                Some(file),
                format!("第 {} 帧放不进 {fw}×{fh} 的格子 (内容 {w}×{h}), 请调大 frame 或缩小素材", k + 1),
            );
            ok = false;
            continue;
        }
        let dx = ((fw as f64 / 2.0 - median_x(&f.img)).round() as i64).clamp(0, fw as i64 - w);
        let dy = if per_frame { baseline - h } else { f.oy + baseline - max_bottom }.clamp(0, fh as i64 - h);
        image::imageops::overlay(&mut strip, &f.img, k as i64 * fw as i64 + dx, dy);
    }
    if !ok {
        return None;
    }
    let mut heights: Vec<u32> = frames.iter().map(|f| f.img.height()).collect();
    heights.sort_unstable();
    Some((strip, heights[heights.len() / 2]))
}

/// 站姿类动作的角色高度与 idle 比较: AI 分开生成的动作常常一个大一个小, 切换时忽大忽小
fn check_heights(actions: &[NormalizedAction], issues: &mut Issues) {
    let Some(idle) = actions.iter().find(|a| pets::category_of(&a.name) == pets::REQUIRED) else {
        return;
    };
    let base = idle.body_height as f64;
    for a in actions {
        if !HEIGHT_CHECKED.contains(&pets::category_of(&a.name)) || base == 0.0 {
            continue;
        }
        let diff = (a.body_height as f64 - base).abs() / base;
        if diff > HEIGHT_TOLERANCE {
            issues.warn(
                Some(&a.name),
                None,
                format!(
                    "角色高度 {}px 与 idle 的 {}px 相差 {:.0}%, 切换动作时会忽大忽小",
                    a.body_height,
                    idle.body_height,
                    diff * 100.0
                ),
            );
        }
    }
}

/// 落盘: 先写到 <id>.importing, 旧包改名 .bak, 新包就位后删 .bak; 任一步失败回滚改名
#[tauri::command]
pub fn commit_pet_import(app: tauri::AppHandle, token: String, overwrite: bool) -> Result<String, String> {
    let stage = staging_dir(&app, &token)?;
    if stage.join(BLOCKED_MARK).exists() {
        return Err("这个宠物包还有错误, 修好后重新导入".to_string());
    }
    let out = stage.join("out");
    let meta = pets::parse_pet(&out).ok_or("导入缓存已失效, 请重新选择文件")?;
    let id = meta.id.clone();
    let udir = pets::user_pets_dir()?;
    let existing = find_by_id(&udir, &id);
    if existing.is_some() && !overwrite {
        return Err(format!("已存在 id 为 \"{id}\" 的宠物包, 需要确认覆盖"));
    }
    let importing = udir.join(format!("{id}.importing"));
    let _ = std::fs::remove_dir_all(&importing);
    copy_dir(&out, &importing)?;

    let target = udir.join(&id);
    let backup = existing.as_ref().map(|d| d.with_extension("bak"));
    if let (Some(old), Some(bak)) = (&existing, &backup) {
        let _ = std::fs::remove_dir_all(bak);
        std::fs::rename(old, bak).map_err(|e| {
            let _ = std::fs::remove_dir_all(&importing);
            format!("旧宠物包正被占用, 覆盖失败: {e}")
        })?;
    }
    // 目标名被别的东西占着 (比如同名但 id 不同的目录) 时也让出来, 一样走备份
    let displaced = if target.exists() && existing.as_deref() != Some(target.as_path()) {
        let d = target.with_extension("displaced");
        let _ = std::fs::remove_dir_all(&d);
        std::fs::rename(&target, &d).ok().map(|_| d)
    } else {
        None
    };
    if let Err(e) = std::fs::rename(&importing, &target) {
        // 回滚: 新包没放进去, 把旧包改回来
        if let (Some(old), Some(bak)) = (&existing, &backup) {
            let _ = std::fs::rename(bak, old);
        }
        if let Some(d) = &displaced {
            let _ = std::fs::rename(d, &target);
        }
        let _ = std::fs::remove_dir_all(&importing);
        return Err(format!("写入宠物目录失败: {e}"));
    }
    if let Some(bak) = &backup {
        let _ = std::fs::remove_dir_all(bak);
    }
    if let Some(d) = &displaced {
        // 被让位的目录不是同 id 的包, 不能删; 留着并在日志里说明
        eprintln!("[pet_import] {} 与新包目录同名, 已改名为 {}", target.display(), d.display());
    }
    pets::evict_sprites(&id);
    let _ = std::fs::remove_dir_all(&stage);
    Ok(id)
}

#[tauri::command]
pub fn discard_pet_import(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let stage = staging_dir(&app, &token)?;
    if stage.exists() {
        std::fs::remove_dir_all(&stage).map_err(|e| format!("清理导入缓存失败: {e}"))?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("创建目录失败: {e}"))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("读取导入缓存失败: {e}"))?.flatten() {
        let p = entry.path();
        let dest = to.join(entry.file_name());
        if p.is_dir() {
            copy_dir(&p, &dest)?;
        } else {
            std::fs::copy(&p, &dest).map_err(|e| format!("复制 {} 失败: {e}", p.display()))?;
        }
    }
    Ok(())
}
