mod pi_runtime;

use pi_runtime::PiRuntime;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::{Manager, State};
use tokio::sync::Mutex;

const POOL_CAPACITY: usize = 6;

/// 多 session 运行时池: HashMap 管理多个 pi sidecar, LRU 淘汰最久未活动的
struct RuntimePool {
    runtimes: HashMap<String, PiRuntime>,
    last_active: HashMap<String, Instant>,
}

impl RuntimePool {
    fn new() -> Self {
        Self {
            runtimes: HashMap::new(),
            last_active: HashMap::new(),
        }
    }

    /// 更新 session 最近活动时间 (LRU 依据)
    fn touch(&mut self, session_id: &str) {
        self.last_active.insert(session_id.to_string(), Instant::now());
    }

    /// 超过 capacity 时淘汰最久未活动的 runtime (graceful stop)
    async fn evict_lru(&mut self) {
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
        }
    }

    /// 清理所有 runtime (窗口关闭时)
    async fn stop_all(&mut self) {
        for (_, mut rt) in self.runtimes.drain() {
            let _ = rt.stop().await;
        }
        self.last_active.clear();
    }
}

type SharedRuntime = Arc<Mutex<RuntimePool>>;

/// 启动一个 pi sidecar 会话, 返回 sessionId (不替换已有 session, 多个并存)
#[tauri::command]
async fn start_session(
    app: tauri::AppHandle,
    state: State<'_, SharedRuntime>,
    cwd: String,
    provider: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let session_id = format!(
        "sess_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    );
    let runtime = PiRuntime::spawn(app, session_id.clone(), cwd, provider, model).await?;
    let mut guard = state.lock().await;
    guard.runtimes.insert(session_id.clone(), runtime);
    guard.touch(&session_id);
    guard.evict_lru().await;
    Ok(session_id)
}

#[tauri::command]
async fn send_prompt(
    state: State<'_, SharedRuntime>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.touch(&session_id);
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.send_prompt(message).await
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(Mutex::new(RuntimePool::new())) as SharedRuntime)
        .invoke_handler(tauri::generate_handler![
            start_session, send_prompt, abort_session, stop_session,
            get_state, get_available_models, set_model, cycle_model,
            set_thinking_level, cycle_thinking_level, get_available_thinking_levels
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
