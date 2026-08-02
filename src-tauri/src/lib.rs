mod pi_runtime;

use pi_runtime::PiRuntime;
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::Mutex;

/// 全局共享的单个 pi 运行时 (M1 只支持单 session, M3 再加 RuntimePool)
type SharedRuntime = Arc<Mutex<Option<PiRuntime>>>;

/// 启动一个 pi sidecar 会话, 返回 sessionId
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
    // 已有旧 session 先清理
    if let Some(mut old) = guard.take() {
        let _ = old.stop().await;
    }
    *guard = Some(runtime);

    Ok(session_id)
}

/// 发送 prompt
#[tauri::command]
async fn send_prompt(state: State<'_, SharedRuntime>, message: String) -> Result<(), String> {
    let mut guard = state.lock().await;
    let runtime = guard.as_mut().ok_or("没有活跃的 session")?;
    runtime.send_prompt(message).await
}

/// 中止当前 agent 操作
#[tauri::command]
async fn abort_session(state: State<'_, SharedRuntime>) -> Result<(), String> {
    let mut guard = state.lock().await;
    let runtime = guard.as_mut().ok_or("没有活跃的 session")?;
    runtime.abort().await
}

/// 停止并清理 pi 子进程
#[tauri::command]
async fn stop_session(state: State<'_, SharedRuntime>) -> Result<(), String> {
    let mut guard = state.lock().await;
    if let Some(mut runtime) = guard.take() {
        runtime.stop().await?;
    }
    Ok(())
}

// --- M2: 模型与思考级别控制 (request-response, 同步返回) ---

#[tauri::command]
async fn get_state(state: State<'_, SharedRuntime>) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.as_mut().ok_or("没有活跃的 session")?;
    runtime.get_state().await
}

#[tauri::command]
async fn get_available_models(state: State<'_, SharedRuntime>) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.as_mut().ok_or("没有活跃的 session")?;
    runtime.get_available_models().await
}

#[tauri::command]
async fn set_model(state: State<'_, SharedRuntime>, provider: String, model_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.as_mut().ok_or("没有活跃的 session")?;
    runtime.set_model(provider, model_id).await
}

#[tauri::command]
async fn cycle_model(state: State<'_, SharedRuntime>) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.as_mut().ok_or("没有活跃的 session")?;
    runtime.cycle_model().await
}

#[tauri::command]
async fn set_thinking_level(state: State<'_, SharedRuntime>, level: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.as_mut().ok_or("没有活跃的 session")?;
    runtime.set_thinking_level(level).await
}

#[tauri::command]
async fn cycle_thinking_level(state: State<'_, SharedRuntime>) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.as_mut().ok_or("没有活跃的 session")?;
    runtime.cycle_thinking_level().await
}

#[tauri::command]
async fn get_available_thinking_levels(state: State<'_, SharedRuntime>) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    let runtime = guard.as_mut().ok_or("没有活跃的 session")?;
    runtime.get_available_thinking_levels().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(Mutex::new(None::<PiRuntime>)) as SharedRuntime)
        .invoke_handler(tauri::generate_handler![
            start_session,
            send_prompt,
            abort_session,
            stop_session,
            get_state,
            get_available_models,
            set_model,
            cycle_model,
            set_thinking_level,
            cycle_thinking_level,
            get_available_thinking_levels
        ])
        .on_window_event(|window, event| {
            // 窗口关闭时清理 pi 子进程, 不留僵尸进程
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<SharedRuntime>() {
                    let state = state.inner().clone();
                    tauri::async_runtime::spawn(async move {
                        let mut guard = state.lock().await;
                        if let Some(mut runtime) = guard.take() {
                            let _ = runtime.stop().await;
                        }
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}