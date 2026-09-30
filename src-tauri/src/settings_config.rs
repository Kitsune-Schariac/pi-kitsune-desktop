//! settings.json 的「新会话默认」三个键读写 (设置窗「模型与供应商」页的默认条)。
//!
//! ## 为什么不照搬 models.json 的「整份文档 + mtime 乐观锁」
//! settings.json 是 pi 的活跃写入对象 (切主题、记 changelog 版本、TUI 的 /model 都会写)。
//! 整份覆盖会抹掉 pi 在面板打开期间写入的键; 按 mtime 判冲突则会让用户频繁撞上与本页
//! 无关的冲突。这里对齐 pi 自己的写法 (settings-manager.js withLock + persistScopedSettings):
//! 加锁 → 读当前文件 → 只合并改过的键 → 写回。
//!
//! ## 写入六步
//! ① 加锁 (兼容 proper-lockfile: `settings.json.lock` 目录, 20ms × 10 次, 10s 视为残留锁)
//! → ② 读当前文件 (不存在从 `{}` 开始, 非法 JSON 拒绝) → ③ 三键与 expected 比对, 不符即冲突
//! → ④ 只改三键 → ⑤ 备份 + 同目录临时文件 rename → ⑥ 释放锁 (LockGuard Drop, 出错路径同样释放)。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const KEY_PROVIDER: &str = "defaultProvider";
const KEY_MODEL: &str = "defaultModel";
const KEY_THINKING: &str = "defaultThinkingLevel";

/// proper-lockfile 默认 stale 阈值; pi 持锁只有一次同步读写, 远小于它
const LOCK_STALE: Duration = Duration::from_secs(10);

/// 三个默认键; 键缺失或不是字符串时为空串, 写入时空串 = 删除该键
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct SessionDefaults {
    pub provider: String,
    pub model: String,
    pub thinking: String,
}

/// 读取快照。`parse_error` 非空时前端默认条只读, 防止以空值覆盖用户的坏文件
#[derive(Serialize, Debug)]
pub struct SettingsDefaultsSnapshot {
    pub path: String,
    pub exists: bool,
    pub parse_error: Option<String>,
    pub defaults: SessionDefaults,
}

#[tauri::command]
pub fn read_session_defaults() -> Result<SettingsDefaultsSnapshot, String> {
    let path = crate::session_fs::agent_dir()?.join("settings.json");
    read_snapshot(&path)
}

/// `expected` 是面板加载时读到的值 (冲突检测基线), 返回写入后的实际值 (新基线)
#[tauri::command]
pub fn write_session_defaults(
    expected: SessionDefaults,
    next: SessionDefaults,
) -> Result<SessionDefaults, String> {
    let path = crate::session_fs::agent_dir()?.join("settings.json");
    write_defaults(&path, &expected, &next, LOCK_STALE)
}

fn read_snapshot(path: &Path) -> Result<SettingsDefaultsSnapshot, String> {
    let display = path.to_string_lossy().to_string();
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SettingsDefaultsSnapshot {
                path: display,
                exists: false,
                parse_error: None,
                defaults: SessionDefaults::default(),
            });
        }
        Err(e) => return Err(format!("读取 settings.json 失败: {e}")),
    };
    Ok(match parse_object(&text) {
        Ok(obj) => SettingsDefaultsSnapshot {
            path: display,
            exists: true,
            parse_error: None,
            defaults: defaults_of(&obj),
        },
        Err(e) => SettingsDefaultsSnapshot {
            path: display,
            exists: true,
            parse_error: Some(e),
            defaults: SessionDefaults::default(),
        },
    })
}

fn parse_object(text: &str) -> Result<Map<String, Value>, String> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(obj)) => Ok(obj),
        Ok(_) => Err("settings.json 顶层不是 JSON 对象".into()),
        Err(e) => Err(format!("settings.json 解析失败: {e}")),
    }
}

fn defaults_of(obj: &Map<String, Value>) -> SessionDefaults {
    let get = |k: &str| obj.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    SessionDefaults {
        provider: get(KEY_PROVIDER),
        model: get(KEY_MODEL),
        thinking: get(KEY_THINKING),
    }
}

fn write_defaults(
    path: &Path,
    expected: &SessionDefaults,
    next: &SessionDefaults,
    stale: Duration,
) -> Result<SessionDefaults, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    // ① 锁持有到函数返回 (含全部错误路径), Drop 时删锁目录
    let _lock = LockGuard::acquire(path, stale)?;

    // ② 以磁盘当前内容为准合并, 面板加载后 pi 写入的其他键因此不会丢
    let (mut obj, exists) = match std::fs::read_to_string(path) {
        Ok(text) => (parse_object(&text).map_err(|e| format!("{e}, 为避免覆盖不做写入"))?, true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Map::new(), false),
        Err(e) => return Err(format!("读取 settings.json 失败: {e}")),
    };

    // ③ 只比这三个键: pi 改别的键 (主题 / changelog 版本) 不算冲突
    let current = defaults_of(&obj);
    if &current != expected {
        return Err(format!(
            "冲突: settings.json 的默认模型已被其他程序修改 (当前 {}/{} · {}), 请重新加载后再保存",
            or_dash(&current.provider),
            or_dash(&current.model),
            or_dash(&current.thinking)
        ));
    }
    if &current == next {
        return Ok(current);
    }

    // ④ 只动值变了的键; 未变的键连同其原始值 (哪怕是非字符串怪值) 原样保留
    for (key, before, after) in [
        (KEY_PROVIDER, &current.provider, &next.provider),
        (KEY_MODEL, &current.model, &next.model),
        (KEY_THINKING, &current.thinking, &next.thinking),
    ] {
        if before == after {
            continue;
        }
        if after.is_empty() {
            obj.shift_remove(key);
        } else if let Some(v) = obj.get_mut(key) {
            // 已有键原位改值, 保持它在文件里的位置
            *v = Value::String(after.clone());
        } else {
            obj.insert(key.to_string(), Value::String(after.clone()));
        }
    }

    // ⑤ 备份失败即中止; 2 空格缩进 + 无末尾换行, 与 pi 的 JSON.stringify(x, null, 2) 同格式
    if exists {
        let bak = sibling(path, "bak");
        std::fs::copy(path, &bak).map_err(|e| format!("创建备份失败 ({}): {e}", bak.display()))?;
    }
    let pretty = serde_json::to_string_pretty(&Value::Object(obj.clone()))
        .map_err(|e| format!("序列化失败: {e}"))?;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = sibling(path, &format!("tmp.{}.{nanos}", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, pretty) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入临时文件失败: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换 settings.json 失败: {e}"));
    }
    Ok(defaults_of(&obj))
}

fn or_dash(s: &str) -> &str {
    if s.is_empty() { "-" } else { s }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "settings.json".into());
    path.with_file_name(format!("{name}.{suffix}"))
}

/// proper-lockfile 兼容锁: 锁本体是 `<file>.lock` 目录 (mkdir 原子), pi 的 lockSync 与我们
/// 互斥靠的就是同一个目录名
struct LockGuard {
    dir: PathBuf,
}

impl LockGuard {
    fn acquire(path: &Path, stale: Duration) -> Result<Self, String> {
        let dir = sibling(path, "lock");
        // 与 pi acquireLockSyncWithRetry 同参数: 20ms 间隔, 最多 10 次
        for _ in 0..10 {
            match std::fs::create_dir(&dir) {
                Ok(()) => return Ok(Self { dir }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // 持锁进程崩溃会留下锁目录; 与 proper-lockfile 一致, mtime 超过阈值视为残留
                    let is_stale = std::fs::metadata(&dir)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .map(|age| age > stale)
                        .unwrap_or(false);
                    if is_stale {
                        let _ = std::fs::remove_dir(&dir);
                        continue;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => return Err(format!("获取 settings.json 锁失败: {e}")),
            }
        }
        Err("pi 正在写入设置 (settings.json 被锁定), 请稍后重试".into())
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sc_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn d(p: &str, m: &str, t: &str) -> SessionDefaults {
        SessionDefaults { provider: p.into(), model: m.into(), thinking: t.into() }
    }

    /// 仿 pi 真实文件: 非字母序键、中文、反斜杠路径、嵌套对象与数组, JSON.stringify 2 空格格式
    const PI_STYLE: &str = r#"{
  "lastChangelogVersion": "0.86.0",
  "theme": "kitsune-neon",
  "defaultProvider": "axonHub-native",
  "defaultModel": "cline-pass/deepseek-v4.1-flash",
  "defaultThinkingLevel": "max",
  "shellPath": "C:\\dev_tools\\Git\\bin\\bash.exe",
  "observational-memory": {
    "passive": false,
    "compactAfterTokens": 500000
  },
  "packages": [
    "npm:pi-subagents",
    "..\\..\\workspace\\pi-kitsune-ui"
  ],
  "备注": "中文值 ✓",
  "httpProxy": "http://127.0.0.1:7890"
}"#;

    /// 只改三键: 其余键逐字节不变, 键位置不变 (A11)
    #[test]
    fn only_three_keys_change_and_rest_is_byte_identical() {
        let dir = temp_dir("merge");
        let path = dir.join("settings.json");
        std::fs::write(&path, PI_STYLE).unwrap();
        let out = write_defaults(
            &path,
            &d("axonHub-native", "cline-pass/deepseek-v4.1-flash", "max"),
            &d("yuki", "deepseek-v4-pro", "high"),
            LOCK_STALE,
        )
        .unwrap();
        assert_eq!(out, d("yuki", "deepseek-v4-pro", "high"));
        let expected = PI_STYLE
            .replace("\"axonHub-native\"", "\"yuki\"")
            .replace("\"cline-pass/deepseek-v4.1-flash\"", "\"deepseek-v4-pro\"")
            .replace("\"defaultThinkingLevel\": \"max\"", "\"defaultThinkingLevel\": \"high\"");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
        assert_eq!(std::fs::read_to_string(dir.join("settings.json.bak")).unwrap(), PI_STYLE);
        assert!(!dir.join("settings.json.lock").exists(), "锁必须释放");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 空串 = 删键; 新键追加到末尾, 已有键保持位置
    #[test]
    fn empty_removes_key_and_new_key_appends() {
        let dir = temp_dir("remove");
        let path = dir.join("settings.json");
        std::fs::write(&path, "{\n  \"theme\": \"x\",\n  \"defaultModel\": \"m\"\n}").unwrap();
        write_defaults(&path, &d("", "m", ""), &d("p", "", ""), LOCK_STALE).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"theme\": \"x\",\n  \"defaultProvider\": \"p\"\n}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 三键被外部改过 → 冲突, 文件分毫未动; 其他键被改过 → 不算冲突, 且新值保留
    #[test]
    fn conflict_only_on_the_three_keys() {
        let dir = temp_dir("conflict");
        let path = dir.join("settings.json");
        std::fs::write(&path, PI_STYLE).unwrap();
        let err = write_defaults(&path, &d("old", "old", "max"), &d("a", "b", "c"), LOCK_STALE).unwrap_err();
        assert!(err.contains("冲突"), "前端靠「冲突」识别: {err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), PI_STYLE);
        assert!(!dir.join("settings.json.lock").exists(), "出错路径也必须释放锁");

        // pi 在面板打开期间改了主题: 不冲突, 合并后主题新值还在
        std::fs::write(&path, PI_STYLE.replace("kitsune-neon", "tokyo-night")).unwrap();
        write_defaults(
            &path,
            &d("axonHub-native", "cline-pass/deepseek-v4.1-flash", "max"),
            &d("axonHub-native", "cline-pass/deepseek-v4.1-flash", "low"),
            LOCK_STALE,
        )
        .unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("tokyo-night") && saved.contains("\"defaultThinkingLevel\": \"low\""));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn creates_file_when_missing() {
        let dir = temp_dir("missing");
        let path = dir.join("sub").join("settings.json");
        let snap = read_snapshot(&path).unwrap();
        assert!(!snap.exists && snap.parse_error.is_none());
        write_defaults(&path, &SessionDefaults::default(), &d("p", "m", "off"), LOCK_STALE).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v, serde_json::json!({ "defaultProvider": "p", "defaultModel": "m", "defaultThinkingLevel": "off" }));
        assert!(!path.with_file_name("settings.json.bak").exists(), "原本无文件时不该产生备份");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 坏文件: 读取给 parse_error, 写入拒绝且不覆盖
    #[test]
    fn rejects_invalid_json() {
        let dir = temp_dir("invalid");
        let path = dir.join("settings.json");
        for bad in ["{ not json", "[1, 2]"] {
            std::fs::write(&path, bad).unwrap();
            assert!(read_snapshot(&path).unwrap().parse_error.is_some());
            assert!(write_defaults(&path, &SessionDefaults::default(), &d("p", "", ""), LOCK_STALE).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), bad);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 残留锁 (超过 stale 阈值) 被清理后照常写入
    #[test]
    fn clears_stale_lock() {
        let dir = temp_dir("stale");
        let path = dir.join("settings.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::create_dir(dir.join("settings.json.lock")).unwrap();
        std::thread::sleep(Duration::from_millis(80));
        write_defaults(&path, &SessionDefaults::default(), &d("p", "", ""), Duration::from_millis(30)).unwrap();
        assert!(read_snapshot(&path).unwrap().defaults.provider == "p");
        assert!(!dir.join("settings.json.lock").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 活锁 (pi 正持有) → 重试耗尽后报错, 不删别人的锁, 文件不动
    #[test]
    fn live_lock_times_out() {
        let dir = temp_dir("live");
        let path = dir.join("settings.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::create_dir(dir.join("settings.json.lock")).unwrap();
        let err = write_defaults(&path, &SessionDefaults::default(), &d("p", "", ""), LOCK_STALE).unwrap_err();
        assert!(err.contains("pi 正在写入设置"), "{err}");
        assert!(dir.join("settings.json.lock").exists(), "活锁属于 pi, 不能删");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
