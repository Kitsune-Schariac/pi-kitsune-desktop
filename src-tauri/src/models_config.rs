//! models.json 配置读写 (设置窗「模型」tab 的数据源): 整份文档的读取与原子写回。
//!
//! ## 为什么整份 Value 读写, 不做强类型 round-trip
//! `~/.pi/agent/models.json` 的 `compat` 有 20+ 开关且随 pi 版本演进 (thinkingFormat
//! 一个枚举就十余个取值)。若定义 struct 走反序列化→修改→序列化, 本版本不认识的字段
//! 会在写回时静默消失 —— 用户升级 pi 后新加的配置被 GUI 一次保存抹掉, 是必然发生的数据
//! 损坏而非边缘情况。因此全链路以 `serde_json::Value` 承载文档: 读 = 解析成 Value 交给
//! 前端; 写 = 收 Value → 结构校验 → 原子写回。仅命令的返回值定义 struct
//! (Snapshot / WriteResult), 文档内容本身绝不进强类型。
//! (注: serde_json 默认 Map 是键序 BTreeMap, 写回时键会按字典序归一 —— 但键与值一个
//! 不少, pi 不依赖键序, 字段保真才是契约)
//!
//! ## 为什么只暴露读/写两个数据命令
//! 保真约束要求整份文档来回传, 细粒度命令 (add_provider / update_model / ...) 只会把
//! pi 的 upsert 合并语义 (同 id 替换、新 id 追加) 复制一份到 Rust, 两处维护必生分歧。
//! 文件仅 ~17KB, 整份传输开销可忽略; 前端表单只对 Value 树做定点赋值, 未触及的键原样
//! 保留。
//!
//! ## 写入安全 (五步顺序不可调换)
//! ① 乐观锁 (mtime 比对, 拒绝覆盖面板打开期间的外部修改) → ② 结构校验 (只查会让 pi
//! 起不来或行为异常的结构性问题, 不校验 compat 内部 —— 那是 pi 的领域且在演进) →
//! ③ 备份 `models.json.bak` (备份失败即致命, 没有回滚路径就不动用户文件) → ④ 同目录
//! 临时文件 + rename 覆盖 (原子写, rename 不跨卷) → ⑤ 返回新 mtime 续乐观锁令牌。

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 读取快照。文件缺失与 JSON 非法是两种不同状态, 前端要区别对待:
/// - 缺失: 空状态, 可引导创建; `mtime_ms` 为 0 (乐观锁令牌 = 0 表示读取时无文件)
/// - 非法: `parse_error` 给出详情且 `raw` 为 None, 前端必须禁用全部写操作,
///   防止以空配置覆盖用户的坏文件
#[derive(Serialize, Debug)]
pub struct ModelsConfigSnapshot {
    pub path: String,
    pub exists: bool,
    pub raw: Option<Value>,
    pub parse_error: Option<String>,
    pub mtime_ms: u64,
}

/// 写回结果。`mtime_ms` 是新的乐观锁令牌, 前端保存后必须用它替换旧值。
#[derive(Serialize, Debug)]
pub struct WriteResult {
    pub mtime_ms: u64,
    pub backup_path: Option<String>,
}

/// 读取整份配置。文件只读不写, 无需参数。
#[tauri::command]
pub fn read_models_config() -> Result<ModelsConfigSnapshot, String> {
    // 路径复用 session_fs::agent_dir, 与补全场景的 provider 列表同源, 不重造
    let path = crate::session_fs::agent_dir()?.join("models.json");
    read_snapshot(&path)
}

/// 写回整份配置。`expected_mtime_ms` 是读取时拿到的乐观锁令牌。
#[tauri::command]
pub fn write_models_config(content: Value, expected_mtime_ms: u64) -> Result<WriteResult, String> {
    let path = crate::session_fs::agent_dir()?.join("models.json");
    write_document(&path, &content, expected_mtime_ms)
}

/// 文件 mtime (UNIX_EPOCH 起毫秒); 文件不存在返回 None。
/// 读与写必须用同一算法比对, 避免 Windows 下精度取整引入假冲突。
fn file_mtime_ms(path: &Path) -> Result<Option<u64>, String> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取文件状态失败: {e}")),
    };
    let modified = meta
        .modified()
        .map_err(|e| format!("读取修改时间失败: {e}"))?;
    let ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("时间转换失败: {e}"))?
        .as_millis() as u64;
    Ok(Some(ms))
}

/// 读快照 (内部, 路径由调用方给; 命令层只负责拼路径 + 错误转字符串)
fn read_snapshot(path: &Path) -> Result<ModelsConfigSnapshot, String> {
    let display = path.to_string_lossy().to_string();
    let Some(mtime_ms) = file_mtime_ms(path)? else {
        return Ok(ModelsConfigSnapshot {
            path: display,
            exists: false,
            raw: None,
            parse_error: None,
            mtime_ms: 0,
        });
    };
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取 models.json 失败: {e}"))?;
    match serde_json::from_str::<Value>(&text) {
        Ok(raw) => Ok(ModelsConfigSnapshot {
            path: display,
            exists: true,
            raw: Some(raw),
            parse_error: None,
            mtime_ms,
        }),
        Err(e) => Ok(ModelsConfigSnapshot {
            path: display,
            exists: true,
            raw: None,
            parse_error: Some(format!("JSON 解析失败: {e}")),
            mtime_ms,
        }),
    }
}

/// 写回 (内部, 五步顺序不可调换): 乐观锁 → 校验 → 备份 → 原子写 → 新令牌
fn write_document(
    path: &Path,
    content: &Value,
    expected_mtime_ms: u64,
) -> Result<WriteResult, String> {
    // ① 乐观锁: 面板打开期间文件被外部修改 (编辑器/pi 自身) → 拒绝覆盖, 前端识别
    // "mtime 冲突" 后提示重新加载, 由用户决定是否放弃本地改动
    let now = file_mtime_ms(path)?;
    if now.unwrap_or(0) != expected_mtime_ms {
        return Err("mtime 冲突: models.json 已被其他程序修改, 请重新加载配置后再保存".into());
    }
    // ② 结构校验: 最后一道闸, 不过绝不落盘
    validate_models_doc(content)?;
    // ③ 备份: 没有回滚路径就不动用户文件, 备份失败一律视为致命
    let backup_path = if path.is_file() {
        let bak = backup_path_for(path);
        std::fs::copy(path, &bak)
            .map_err(|e| format!("创建备份失败 ({}): {e}", bak.display()))?;
        Some(bak.to_string_lossy().to_string())
    } else {
        None
    };
    // ④ 原子写: 同目录临时文件 + rename 覆盖 (rename 不跨卷; Windows 上可覆盖已存在文件)
    // ~/.pi/agent 可能还不存在 (新装 pi 且从未运行): 不建目录的话, 空状态那条「创建初始配置」
    // 路径会在这一步才炸, 用户看到的是莫名其妙的写入失败而不是「目录不存在」
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let pretty = serde_json::to_string_pretty(content).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = temp_path_for(path);
    if let Err(e) = std::fs::write(&tmp, pretty) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入临时文件失败: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换 models.json 失败: {e}"));
    }
    // ⑤ 新乐观锁令牌 (刚写的文件, metadata 必可读; 失败上抛让前端重新加载)
    let mtime_ms = file_mtime_ms(path)?.unwrap_or(0);
    Ok(WriteResult {
        mtime_ms,
        backup_path,
    })
}

fn backup_path_for(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "models.json".into());
    path.with_file_name(format!("{name}.bak"))
}

/// 临时文件带进程 id + 纳秒后缀, 防并发保存撞名
fn temp_path_for(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "models.json".into());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    path.with_file_name(format!("{name}.tmp.{}.{nanos}", std::process::id()))
}

/// 结构校验 (design §2.3): 只查会让 pi 起不来或行为异常的结构性问题。
/// 不校验 compat 内部字段 —— 那是 pi 的领域知识且在演进, GUI 不做二次把关。
/// 错误信息带 provider / model 定位, 用户才能找到是哪一行配置有问题。
fn validate_models_doc(v: &Value) -> Result<(), String> {
    let Some(root) = v.as_object() else {
        return Err(format!("配置顶层必须是 JSON 对象, 当前是 {}", value_kind(v)));
    };
    // providers 缺失视为空配置 (允许创建), 存在则必须是对象
    let Some(providers) = root.get("providers") else {
        return Ok(());
    };
    let Some(pmap) = providers.as_object() else {
        return Err("`providers` 必须是对象".into());
    };
    for (pid, pv) in pmap {
        if pid.trim().is_empty() || pid.trim() != pid {
            return Err(format!("provider id 不能为空或带前后空白: {pid:?}"));
        }
        let Some(pobj) = pv.as_object() else {
            return Err(format!("provider {pid:?} 的配置必须是对象"));
        };
        if let Some(api) = pobj.get("api") {
            if !is_valid_api(api) {
                return Err(format!("provider {pid:?} 的 api 值非法: {api}"));
            }
        }
        if let Some(models) = pobj.get("models") {
            let Some(arr) = models.as_array() else {
                return Err(format!("provider {pid:?} 的 models 必须是数组"));
            };
            let mut seen: HashSet<&str> = HashSet::new();
            for m in arr {
                let Some(mobj) = m.as_object() else {
                    return Err(format!("provider {pid:?} 的 models 内含非对象项: {m}"));
                };
                let mid = mobj.get("id").and_then(|x| x.as_str()).unwrap_or("");
                let mid = mid.trim();
                if mid.is_empty() {
                    return Err(format!("provider {pid:?} 下存在缺少非空 id 的模型"));
                }
                if !seen.insert(mid) {
                    return Err(format!("provider {pid:?} 下模型 id 重复: {mid:?}"));
                }
                if let Some(api) = mobj.get("api") {
                    if !is_valid_api(api) {
                        return Err(format!("provider {pid:?} 下模型 {mid:?} 的 api 值非法: {api}"));
                    }
                }
                validate_model_numbers(pid, mid, mobj)?;
            }
        }
        // 只覆盖内置模型个别字段, 不替换模型列表; 值必须是对象 (与 models[] 语义不同)
        if let Some(ov) = pobj.get("modelOverrides") {
            let Some(ovobj) = ov.as_object() else {
                return Err(format!("provider {pid:?} 的 modelOverrides 必须是对象"));
            };
            for (mid, mv) in ovobj {
                if !mv.is_object() {
                    return Err(format!(
                        "provider {pid:?} 的 modelOverrides[{mid:?}] 必须是对象"
                    ));
                }
            }
        }
    }
    Ok(())
}

/// pi 支持的 API 全量枚举 (docs/custom-provider.md 的 Supported APIs 表)。
/// 只列 4 个常用值会让 azure-openai-responses / google-vertex 这类合法配置被 GUI 拒写 ——
/// 校验的目的是拦住手滑拼错, 不是替 pi 缩窄能力边界。
fn is_valid_api(v: &Value) -> bool {
    matches!(
        v.as_str(),
        Some(
            "anthropic-messages"
                | "openai-completions"
                | "openai-responses"
                | "azure-openai-responses"
                | "openai-codex-responses"
                | "mistral-conversations"
                | "google-generative-ai"
                | "google-vertex"
                | "bedrock-converse-stream"
        )
    )
}

/// 模型级数值字段校验: cost 的各键必须是数字, contextWindow / maxTokens 必须是正整数
fn validate_model_numbers(
    pid: &str,
    mid: &str,
    mobj: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    for key in ["contextWindow", "maxTokens"] {
        if let Some(v) = mobj.get(key) {
            if !v.as_u64().map(|n| n > 0).unwrap_or(false) {
                return Err(format!("provider {pid:?} 下模型 {mid:?} 的 {key} 必须是正整数: {v}"));
            }
        }
    }
    if let Some(cost) = mobj.get("cost") {
        let Some(cobj) = cost.as_object() else {
            return Err(format!("provider {pid:?} 下模型 {mid:?} 的 cost 必须是对象: {cost}"));
        };
        for (k, val) in cobj {
            // tiers 是合法的费率阶梯数组 (docs/models.md), 不是手滑写错的数字
            if k == "tiers" {
                if !val.is_array() {
                    return Err(format!(
                        "provider {pid:?} 下模型 {mid:?} 的 cost.tiers 必须是数组: {val}"
                    ));
                }
                continue;
            }
            if !val.is_number() {
                return Err(format!(
                    "provider {pid:?} 下模型 {mid:?} 的 cost.{k} 必须是数字: {val}"
                ));
            }
        }
        // 四个主键齐全才算合法 cost: pi 侧对 cost 存在时的默认值是全零四键, 后端
        // 手写坏文件 / 第三方工具写残缺 cost 会让 pi 启动校验失败, GUI 保存前已自行
        // 补全, 这里只做最后一道闸。tiers 不是主键不要求, 未知键不动。
        for k in ["input", "output", "cacheRead", "cacheWrite"] {
            match cobj.get(k) {
                Some(v) if v.is_number() => {}
                _ => {
                    return Err(format!(
                        "provider {pid:?} 下模型 {mid:?} 的 cost 缺少数字主键 {k} —— cost 存在时 input/output/cacheRead/cacheWrite 四项必须齐全 (缺失可补 0)"
                    ));
                }
            }
        }
    }
    Ok(())
}

fn value_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "布尔",
        Value::Number(_) => "数字",
        Value::String(_) => "字符串",
        Value::Array(_) => "数组",
        Value::Object(_) => "对象",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 自建临时目录 (测试路径, 绝不碰用户的真实 ~/.pi/agent/models.json)
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mc_{name}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 保真 gate: 含未知键的文档走 read → 改已知字段 → write, 未知键与值必须原样保留。
    /// 这是本模块存在意义的验证 —— 强类型 round-trip 会在这里失败。
    #[test]
    fn unknown_fields_survive_read_edit_write_roundtrip() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("models.json");
        let initial = json!({
            "providers": {
                "deepseek": {
                    "name": "DeepSeek",
                    "api": "openai-completions",
                    "compat": { "thinkingFormat": "deepseek", "futureFlag": 42 },
                    "futureProviderField": { "x": [1, 2, 3] },
                    "models": [
                        { "id": "deepseek-chat", "name": "旧名", "contextWindow": 65536,
                          "futureModelField": "keep-me" }
                    ]
                }
            },
            "topLevelFutureKey": "top-value"
        });
        std::fs::write(&path, serde_json::to_string_pretty(&initial).unwrap()).unwrap();

        // read → 定向改一个已知字段 → write (用快照的 mtime 作乐观锁令牌)
        let snap = read_snapshot(&path).unwrap();
        assert!(snap.exists);
        let mut doc = snap.raw.clone().unwrap();
        doc["providers"]["deepseek"]["models"][0]["name"] = json!("新名");
        let write = write_document(&path, &doc, snap.mtime_ms).unwrap();

        // 再次读取必须拿到新令牌 (顺带验证 ⑤ 返回的 mtime 与磁盘一致, 续锁可用)
        let snap2 = read_snapshot(&path).unwrap();
        assert_eq!(snap2.mtime_ms, write.mtime_ms);

        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let m = &saved["providers"]["deepseek"]["models"][0];
        assert_eq!(m["name"], "新名"); // 已知字段的修改生效
        assert_eq!(m["futureModelField"], "keep-me"); // 模型级未知字段原样保留
        assert_eq!(saved["providers"]["deepseek"]["compat"]["futureFlag"], 42);
        assert_eq!(saved["providers"]["deepseek"]["futureProviderField"]["x"], json!([1, 2, 3]));
        assert_eq!(saved["topLevelFutureKey"], "top-value");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 乐观锁: expected 与磁盘 mtime 不符 → 拒绝且文件分毫未动; 三种冲突形态全覆盖
    #[test]
    fn rejects_stale_mtime_without_touching_file() {
        let dir = temp_dir("lock_stale");
        let path = dir.join("models.json");
        let doc = json!({ "providers": { "p": { "api": "openai-completions" } } });
        let original = serde_json::to_string_pretty(&doc).unwrap();
        std::fs::write(&path, &original).unwrap();

        // 面板打开期间外部改了文件 → mtime 不符 → 拒绝
        let err = write_document(&path, &doc, 1).unwrap_err();
        assert!(err.contains("mtime 冲突"), "前端靠 'mtime 冲突' 识别冲突分支: {err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original, "冲突时绝不能动文件");

        // expected=0 表示读取时文件不存在, 现在文件已存在 → 同样判冲突
        let err = write_document(&path, &doc, 0).unwrap_err();
        assert!(err.contains("mtime 冲突"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

        // expected!=0 但文件已被外部删除 → 判冲突 (防止复活已删配置)
        std::fs::remove_file(&path).unwrap();
        let err = write_document(&path, &doc, 12345).unwrap_err();
        assert!(err.contains("mtime 冲突"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 结构校验: 各类会让 pi 起不来的文档各自被拒, 错误信息带定位
    #[test]
    fn validation_rejects_structural_breakage() {
        let cases: Vec<(Value, &str)> = vec![
            (json!([]), "顶层必须是 JSON 对象"),
            (json!({ "providers": [] }), "providers"),
            (json!({ "providers": { "p": "not-an-object" } }), "provider"),
            (json!({ "providers": { "  spaced  ": {} } }), "provider id"),
            (json!({ "providers": { "p": { "models": { "id": "m" } } } }), "models 必须是数组"),
            (json!({ "providers": { "p": { "models": [{ "name": "no-id" }] } } }), "缺少非空 id"),
            (json!({ "providers": { "p": { "models": [{ "id": "a" }, { "id": "a" }] } } }), "id 重复"),
            (json!({ "providers": { "p": { "api": "bogus-api" } } }), "api 值非法"),
            (json!({ "providers": { "p": { "models": [{ "id": "a", "api": "bogus-api" }] } } }), "api 值非法"),
            (json!({ "providers": { "p": { "modelOverrides": { "m": [] } } } }), "modelOverrides"),
            (json!({ "providers": { "p": { "models": [{ "id": "a", "contextWindow": -5 }] } } }), "contextWindow"),
            (json!({ "providers": { "p": { "models": [{ "id": "a", "maxTokens": 0 }] } } }), "maxTokens"),
            (json!({ "providers": { "p": { "models": [{ "id": "a", "cost": { "input": "x" } }] } } }), "cost"),
            (json!({ "providers": { "p": { "models": [{ "id": "a", "cost": {
                "input": 1, "output": 2, "cacheRead": 0
            } }] } } }), "缺少数字主键 cacheWrite"),
            (json!({ "providers": { "p": { "models": [{ "id": "a", "cost": {
                "output": 2, "cacheRead": 0, "cacheWrite": 0
            } }] } } }), "缺少数字主键 input"),
        ];
        for (doc, frag) in cases {
            let err = validate_models_doc(&doc).unwrap_err();
            assert!(err.contains(frag), "期望错误含 {frag:?}, 实际: {err}");
        }
        // 健康文档 (覆盖全部允许字段形态) 不应被误杀
        let healthy = json!({
            "providers": {
                "p": {
                    "api": "anthropic-messages",
                    "models": [
                        { "id": "m1", "contextWindow": 200000, "maxTokens": 8192,
                          "cost": { "input": 3, "output": 15, "cacheRead": 0.5, "cacheWrite": 0 } }
                    ],
                    "modelOverrides": { "m2": { "name": "x" } }
                }
            }
        });
        validate_models_doc(&healthy).unwrap();
    }

    /// 校验只能拦手滑拼错, 不能替 pi 缩窄能力边界: 文档支持的 9 个 api 与 cost.tiers
    /// 数组都是合法配置, 误杀等于用户没法配 azure / vertex 这类 provider 或阶梯费率
    #[test]
    fn validation_accepts_full_api_enum_and_cost_tiers() {
        for api in [
            "anthropic-messages",
            "openai-completions",
            "openai-responses",
            "azure-openai-responses",
            "openai-codex-responses",
            "mistral-conversations",
            "google-generative-ai",
            "google-vertex",
            "bedrock-converse-stream",
        ] {
            let doc = json!({ "providers": { "p": { "api": api } } });
            validate_models_doc(&doc).unwrap_or_else(|e| panic!("合法 api {api} 被误杀: {e}"));
        }
        let doc = json!({ "providers": { "p": { "models": [{ "id": "m", "cost": {
            "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite": 6.25,
            "tiers": [{ "inputTokensAbove": 272000, "input": 10, "output": 45 }]
        } }] } } });
        validate_models_doc(&doc).unwrap();
        // tiers 写成对象仍要拦住 (那是真拼错)
        let bad = json!({ "providers": { "p": { "models": [{ "id": "m",
            "cost": { "tiers": {} } }] } } });
        assert!(validate_models_doc(&bad).unwrap_err().contains("tiers"));
    }

    /// 备份 + 原子写: .bak 等于写前内容, 新文件可重新解析且等于写后内容, 无临时文件残留
    #[test]
    fn writes_backup_and_atomically_replaces() {
        let dir = temp_dir("backup");
        let path = dir.join("models.json");
        let old = json!({ "providers": { "a": { "api": "openai-completions" } } });
        let old_text = serde_json::to_string_pretty(&old).unwrap();
        std::fs::write(&path, &old_text).unwrap();
        let snap = read_snapshot(&path).unwrap();

        let new = json!({ "providers": {
            "a": { "api": "openai-completions" },
            "b": { "baseUrl": "http://x" }
        }});
        let res = write_document(&path, &new, snap.mtime_ms).unwrap();
        assert!(res.backup_path.is_some());

        let bak = path.with_file_name("models.json.bak");
        assert!(bak.is_file());
        assert_eq!(
            std::fs::read_to_string(&bak).unwrap(),
            old_text,
            "备份必须等于写前内容"
        );
        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed, new, "写后内容必须能重新解析且等于写回值");
        // 原子写不留半截文件: 目录里只有 models.json + models.json.bak
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 读取三态: 不存在 (空态) / 存在但 JSON 非法 (明确错误 + raw=None) / 正常
    #[test]
    fn read_distinguishes_missing_invalid_and_valid() {
        let dir = temp_dir("read_states");
        let path = dir.join("models.json");

        let snap = read_snapshot(&path).unwrap();
        assert!(!snap.exists);
        assert!(snap.raw.is_none());
        assert!(snap.parse_error.is_none());
        assert_eq!(snap.mtime_ms, 0, "文件不存在时乐观锁令牌必须为 0");

        std::fs::write(&path, "{ this is not json").unwrap();
        let snap = read_snapshot(&path).unwrap();
        assert!(snap.exists);
        assert!(snap.raw.is_none(), "非法 JSON 时 raw 必须为 None, 前端据此禁用写操作");
        assert!(snap.parse_error.as_deref().unwrap().contains("JSON 解析失败"));

        std::fs::write(&path, r#"{"providers": {"p": {}}}"#).unwrap();
        let snap = read_snapshot(&path).unwrap();
        assert!(snap.exists);
        assert!(snap.parse_error.is_none());
        assert!(snap.raw.is_some());
        assert!(snap.mtime_ms > 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}