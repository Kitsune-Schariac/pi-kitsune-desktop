mod pi_runtime;
mod session_fs;
mod token_stats;

use pi_runtime::PiRuntime;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

const POOL_CAPACITY: usize = 6;

/// 多 session 运行时池: HashMap 管理多个 pi sidecar, LRU 淘汰最久未活动的
/// M4.5: 预热槽 (warm) — 打开会话后后台预 spawn 同 cwd 的 pi, 下次点击直接复用
struct RuntimePool {
    runtimes: HashMap<String, PiRuntime>,
    last_active: HashMap<String, Instant>,
    /// 预热好的空闲 runtime (cwd 匹配时复用, 避免 pi 冷启动 ~3.5s)
    warm: Option<PiRuntime>,
    warm_cwd: Option<String>,
    /// 预热 spawn 进行中 (防并发重复预热)
    warming: bool,
}

impl RuntimePool {
    fn new() -> Self {
        Self {
            runtimes: HashMap::new(),
            last_active: HashMap::new(),
            warm: None,
            warm_cwd: None,
            warming: false,
        }
    }

    /// 更新 session 最近活动时间 (LRU 依据)
    fn touch(&mut self, session_id: &str) {
        self.last_active.insert(session_id.to_string(), Instant::now());
    }

    /// 取预热 runtime: cwd 匹配才复用, 否则 None (调用方负责替换/丢弃)
    fn take_warm(&mut self, cwd: &str) -> Option<PiRuntime> {
        if self.warm_cwd.as_deref() == Some(cwd) {
            self.warming = false;
            self.warm_cwd = None;
            self.warm.take()
        } else {
            None
        }
    }

    /// 丢弃不匹配的 warm (cwd 变化): 异步 stop 不阻塞调用方
    fn drop_warm(&mut self) {
        if let Some(mut rt) = self.warm.take() {
            self.warm_cwd = None;
            tauri::async_runtime::spawn(async move {
                let _ = rt.stop().await;
            });
        }
        self.warming = false;
    }

    /// 标记预热进行中 (防并发重复); 返回 false = 已有预热在跑
    fn mark_warming(&mut self) -> bool {
        if self.warming || self.warm.is_some() {
            false
        } else {
            self.warming = true;
            true
        }
    }

    /// 预热完成回写 (无论成败都清标志)
    fn finish_warming(&mut self, cwd: String, rt: Result<PiRuntime, String>) {
        self.warming = false;
        if let Ok(rt) = rt {
            self.warm = Some(rt);
            self.warm_cwd = Some(cwd);
        }
    }

    /// 超过 capacity 时淘汰最久未活动的 runtime (graceful stop)
    /// 淘汰后 emit session_evicted: 前端保留 entries 标记 detached, 切回时秒切 + reattach
    async fn evict_lru(&mut self, app: &tauri::AppHandle) {
        while self.runtimes.len() > POOL_CAPACITY {
            // 先 clone 出 victim id, 结束 iter 不可变借用, 再 remove
            let victim = self
                .last_active
                .iter()
                .min_by_key(|(_, t)| *t)
                .map(|(id, _)| id.clone());
            let Some(id) = victim else { break };
            if let Some(mut rt) = self.runtimes.remove(&id) {
                let _ = rt.stop().await;
            }
            self.last_active.remove(&id);
            // 通知前端: pi 进程被 LRU 淘汰, entries 仍在内存, 切回走 reattach 而非报错
            let _ = app.emit("session_evicted", serde_json::json!({ "sessionId": id }));
        }
    }

    /// 清理所有 runtime (窗口关闭时)
    async fn stop_all(&mut self) {
        for (_, mut rt) in self.runtimes.drain() {
            let _ = rt.stop().await;
        }
        self.last_active.clear();
        if let Some(mut rt) = self.warm.take() {
            let _ = rt.stop().await;
        }
        self.warm_cwd = None;
        self.warming = false;
    }
}

type SharedRuntime = Arc<Mutex<RuntimePool>>;

/// 启动一个 pi sidecar 会话, 返回 sessionId (不替换已有 session, 多个并存)
/// session_path 存在时: switch_session 加载历史会话文件
/// M4.5: 优先复用预热 runtime (cwd 匹配); 完成后后台预热同 cwd 的下一个
/// 慢操作 (spawn/switch) 不持有全局锁, 避免并发打开会话互相阻塞
#[tauri::command]
async fn start_session(
    app: tauri::AppHandle,
    state: State<'_, SharedRuntime>,
    cwd: String,
    provider: Option<String>,
    model: Option<String>,
    session_path: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    // reattach 复用原 sessionId: 事件流 rebind 到原 id, 前端缓存 entries 不用迁移 key;
    // 新建会话不传 → 生成新 id
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let session_id = session_id.unwrap_or_else(|| format!("sess_{now_ms}"));

    // 阶段 1 (锁内, 快速): 取 warm / 丢弃不匹配 warm / 标记预热 (防并发重复)
    let warm_rt;
    let need_warm_up = {
        let mut guard = state.lock().await;
        warm_rt = match guard.take_warm(&cwd) {
            Some(rt) => Some(rt),
            None => {
                guard.drop_warm();
                None
            }
        };
        // 无论 warm 是否命中都触发下一轮预热, 保证连续切换始终命中
        guard.mark_warming()
    };

    // 阶段 2 (无锁, 慢操作): spawn (或复用 warm) + switch_session
    let reused_warm = warm_rt.is_some();
    let mut runtime = match warm_rt {
        Some(rt) => rt,
        None => PiRuntime::spawn(app.clone(), session_id.clone(), cwd.clone(), provider, model).await?,
    };
    // warm 复用: 事件流的 sessionId 还停留在预热时的 warm_xxx, 必须 rebind 到真实会话,
    // 否则前端按 sessionId 路由查不到 → 流式事件全部丢弃 → 客户端永远"思考中"
    if reused_warm {
        runtime.rebind_session(session_id.clone()).await;
    }
    if let Some(path) = session_path {
        // 加载历史会话: 切换失败或被扩展取消时停掉 runtime, 防止僵尸 pi 进程
        match runtime.switch_session(path).await {
            Ok(true) => {
                runtime.stop().await?;
                return Err("切换会话被扩展取消".into());
            }
            Ok(false) => {}
            Err(e) => {
                runtime.stop().await?;
                return Err(format!("加载会话失败: {e}"));
            }
        }
    }

    // 阶段 3 (锁内, 快速): 入池 + 触发后台预热
    {
        let mut guard = state.lock().await;
        guard.runtimes.insert(session_id.clone(), runtime);
        guard.touch(&session_id);
        guard.evict_lru(&app).await;
    }
    // 预热: spawn 同 cwd 的 pi 存槽 (spawn 本身 ~10ms, pi 的 3.5s 初始化在后台自然度过;
    // 预热不写 session 文件, 复用后 switch_session 绑定真实会话)
    if need_warm_up {
        let state2 = state.inner().clone();
        let cwd2 = cwd.clone();
        let app2 = app.clone();
        let warm_sid = format!(
            "warm_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis()
        );
        tauri::async_runtime::spawn(async move {
            let rt = PiRuntime::spawn(app2, warm_sid, cwd2.clone(), None, None).await;
            let mut guard = state2.lock().await;
            guard.finish_warming(cwd2, rt);
        });
    }
    Ok(session_id)
}

#[tauri::command]
async fn send_prompt(
    state: State<'_, SharedRuntime>,
    session_id: String,
    message: String,
    images: Option<Vec<serde_json::Value>>,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.touch(&session_id);
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.send_prompt(message, images).await
}

#[tauri::command]
async fn abort_session(state: State<'_, SharedRuntime>, session_id: String) -> Result<(), String> {
    let mut guard = state.lock().await;
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.abort().await
}

#[tauri::command]
async fn stop_session(state: State<'_, SharedRuntime>, session_id: String) -> Result<(), String> {
    let mut guard = state.lock().await;
    if let Some(mut rt) = guard.runtimes.remove(&session_id) {
        guard.last_active.remove(&session_id);
        rt.stop().await?;
    }
    Ok(())
}

// --- 模型与思考级别控制 (带 sessionId) ---

#[tauri::command]
async fn get_state(state: State<'_, SharedRuntime>, session_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.get_state().await
}

#[tauri::command]
async fn get_available_models(state: State<'_, SharedRuntime>, session_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.get_available_models().await
}

#[tauri::command]
async fn set_model(state: State<'_, SharedRuntime>, session_id: String, provider: String, model_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.set_model(provider, model_id).await
}

#[tauri::command]
async fn cycle_model(state: State<'_, SharedRuntime>, session_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.cycle_model().await
}

#[tauri::command]
async fn set_thinking_level(state: State<'_, SharedRuntime>, session_id: String, level: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.set_thinking_level(level).await
}

#[tauri::command]
async fn cycle_thinking_level(state: State<'_, SharedRuntime>, session_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.cycle_thinking_level().await
}

#[tauri::command]
async fn get_available_thinking_levels(state: State<'_, SharedRuntime>, session_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.get_available_thinking_levels().await
}

// --- M4: 会话切换后加载 (历史/统计/重命名) ---

#[tauri::command]
async fn get_entries(state: State<'_, SharedRuntime>, session_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    guard.touch(&session_id);
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.get_entries().await
}

#[tauri::command]
async fn get_session_stats(state: State<'_, SharedRuntime>, session_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    guard.touch(&session_id);
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.get_session_stats().await
}

#[tauri::command]
async fn set_session_name(state: State<'_, SharedRuntime>, session_id: String, name: String) -> Result<(), String> {
    let mut guard = state.lock().await;
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.set_session_name(name).await
}

// --- extension_ui_request 响应 (权限确认弹窗等 dialog 类请求的回复) ---

#[tauri::command]
async fn send_extension_ui_response(
    state: State<'_, SharedRuntime>,
    session_id: String,
    id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.touch(&session_id);
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.send_extension_ui_response(id, payload).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(RuntimePool::new())) as SharedRuntime)
        .setup(|_app| {
            // token 统计索引预热: 后台线程首次全量建索引 (1~2s), 不阻塞启动;
            // 之后 get_token_stats 的增量守卫只 stat + 重扫变化文件
            std::thread::Builder::new()
                .name("token-index-prewarm".into())
                .spawn(|| {
                    let t = Instant::now();
                    token_stats::prewarm();
                    eprintln!("[token-stats] 索引预热完成: {:?}", t.elapsed());
                })
                .ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_session, send_prompt, abort_session, stop_session,
            get_state, get_available_models, set_model, cycle_model,
            set_thinking_level, cycle_thinking_level, get_available_thinking_levels,
            get_entries, get_session_stats, set_session_name,
            send_extension_ui_response,
            session_fs::list_projects_and_sessions, session_fs::delete_session_file,
            session_fs::read_file_for_context, session_fs::list_skills_and_packages,
            session_fs::get_session_file_mtime,
            token_stats::get_token_stats,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<SharedRuntime>() {
                    let state = state.inner().clone();
                    tauri::async_runtime::spawn(async move {
                        let mut guard = state.lock().await;
                        guard.stop_all().await;
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
