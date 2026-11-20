mod attach;
mod backends;
mod behavior_stats;
mod capture;
mod git;
mod local_path;
mod models_config;
mod provider_probe;
mod search;
mod session_fs;
mod settings_config;
mod subagent_fleet;
mod token_stats;
mod trellis_tasks;

use backends::claude::ClaudeBackend;
use backends::pi::{PiBackend, PiWarmPool};
use backends::{AgentKind, AgentRuntime};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

const POOL_CAPACITY: usize = 6;

/// 多 session 运行时池: HashMap 管理多个抽象 AgentRuntime, LRU 淘汰最久未活动的。
/// PI 专属预热槽下沉到 `PiWarmPool`, 不污染其他 Agent 生命周期。
struct RuntimePool {
    runtimes: HashMap<String, AgentRuntime>,
    last_active: HashMap<String, Instant>,
    pi_warm: PiWarmPool,
}

impl RuntimePool {
    fn new() -> Self {
        Self {
            runtimes: HashMap::new(),
            last_active: HashMap::new(),
            pi_warm: PiWarmPool::new(),
        }
    }

    /// 更新 session 最近活动时间 (LRU 依据)
    fn touch(&mut self, session_id: &str) {
        self.last_active.insert(session_id.to_string(), Instant::now());
    }

    /// 超过 capacity 时淘汰最久未活动的 runtime (graceful stop)
    /// 淘汰后 emit session_evicted: 前端保留 entries 标记 detached, 切回走 reattach
    async fn evict_lru(&mut self, app: &tauri::AppHandle) {
        while self.runtimes.len() > POOL_CAPACITY {
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
            let _ = app.emit("session_evicted", serde_json::json!({ "sessionId": id }));
        }
    }

    /// 清理所有 runtime (窗口关闭时)
    async fn stop_all(&mut self) {
        for (_, mut rt) in self.runtimes.drain() {
            let _ = rt.stop().await;
        }
        self.last_active.clear();
        self.pi_warm.stop().await;
    }
}

type SharedRuntime = Arc<Mutex<RuntimePool>>;

/// 应用版本号 (编译期来自 Cargo.toml): 标题栏展示用。
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// --- 模型配置保存后的预热槽废弃 ---

/// 废弃 PI warm 预热槽: pi 只在启动时读 models.json / settings.json, 已就绪的预热槽里是旧配置的进程,
/// 直接弃掉让下一个新建会话重新 spawn。已运行会话不受影响 (UI 侧提示重启)
#[tauri::command]
async fn discard_warm_runtime(state: State<'_, SharedRuntime>) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.pi_warm.drop_warm();
    Ok(())
}

/// 启动一个 Agent 会话, 返回 `{ sessionId, agentKind, capabilities, entries }` (多个会话并存)。
/// 慢操作 (spawn/switch) 不持有全局锁, 避免并发打开会话互相阻塞。
#[tauri::command]
async fn start_session(
    app: tauri::AppHandle,
    state: State<'_, SharedRuntime>,
    cwd: String,
    agent_kind: Option<AgentKind>,
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    session_path: Option<String>,
    session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let kind = agent_kind.unwrap_or(AgentKind::Pi);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let session_id = session_id.unwrap_or_else(|| format!("sess_{now_ms}"));

    match kind {
        AgentKind::Pi => {
            // 首帧直读: 历史会话 entries 由 Rust 直接解析 jsonl (零 pi 进程依赖, ~1ms, 锁外)
            let entries = match &session_path {
                Some(path) => {
                    let abs = crate::session_fs::ensure_within_sessions(std::path::Path::new(path))?;
                    crate::session_fs::read_session_entries(&abs)?
                }
                None => Vec::new(),
            };

            // 阶段 1 (锁内, 快速): 取 warm / 丢弃不匹配 warm / 标记预热
            let warm_rt;
            let warm_epoch = {
                let mut guard = state.lock().await;
                warm_rt = match guard.pi_warm.take_warm(&cwd) {
                    Some(rt) => Some(rt),
                    None => {
                        guard.pi_warm.drop_warm();
                        None
                    }
                };
                guard.pi_warm.mark_warming()
            };

            // 阶段 2 (无锁, 慢操作): spawn (或复用 warm) + switch_session
            let reused_warm = warm_rt.is_some();
            let mut pi = match warm_rt {
                Some(rt) => rt,
                None => PiBackend::spawn(app.clone(), session_id.clone(), cwd.clone(), provider, model).await?,
            };
            if reused_warm {
                pi.rebind_session(session_id.clone()).await;
            }
            if let Some(path) = session_path {
                match pi.switch_session(path).await {
                    Ok(true) => {
                        pi.stop().await?;
                        return Err("切换会话被扩展取消".into());
                    }
                    Ok(false) => {}
                    Err(e) => {
                        pi.stop().await?;
                        return Err(format!("加载会话失败: {e}"));
                    }
                }
            }

            let runtime = AgentRuntime::Pi(pi);
            let capabilities = runtime.capabilities();

            // 阶段 3 (锁内, 快速): 入池 + LRU 淘汰
            {
                let mut guard = state.lock().await;
                guard.runtimes.insert(session_id.clone(), runtime);
                guard.touch(&session_id);
                guard.evict_lru(&app).await;
            }

            // 后台预热同 cwd 的下一个 PI 实例
            if let Some(epoch) = warm_epoch {
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
                    let rt = PiBackend::spawn(app2, warm_sid, cwd2.clone(), None, None).await;
                    let mut guard = state2.lock().await;
                    guard.pi_warm.finish_warming(cwd2, epoch, rt);
                });
            }

            Ok(serde_json::json!({
                "sessionId": session_id,
                "agentKind": kind,
                "capabilities": capabilities,
                "entries": entries,
            }))
        }
        AgentKind::Claude => {
            let (entries, resume_id) = match &session_path {
                Some(path) => {
                    let abs = backends::claude::history::ensure_within_claude_projects(
                        std::path::Path::new(path),
                    )?;
                    let entries = backends::claude::history::read_claude_session_entries(&abs)?;
                    let rid = backends::claude::history::extract_claude_session_id(&abs);
                    (entries, rid)
                }
                None => (Vec::new(), None),
            };
            let mode = permission_mode.unwrap_or_else(|| "auto".to_string());
            let claude = ClaudeBackend::spawn(
                app.clone(),
                session_id.clone(),
                cwd.clone(),
                model,
                Some(mode.clone()),
                resume_id,
                session_path,
                None,
            )
            .await?;
            let runtime = AgentRuntime::Claude(claude);
            let capabilities = runtime.capabilities();
            {
                let mut guard = state.lock().await;
                guard.runtimes.insert(session_id.clone(), runtime);
                guard.touch(&session_id);
                guard.evict_lru(&app).await;
            }
            Ok(serde_json::json!({
                "sessionId": session_id,
                "agentKind": kind,
                "capabilities": capabilities,
                "permissionMode": mode,
                "entries": entries,
            }))
        }
        AgentKind::Agy => Err("Antigravity CLI (ACP) 后端将在 Phase 3 接入，敬请期待".into()),
    }
}

#[tauri::command]
async fn send_prompt(
    state: State<'_, SharedRuntime>,
    session_id: String,
    message: String,
    images: Option<Vec<serde_json::Value>>,
) -> Result<serde_json::Value, String> {
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
async fn send_steer(
    state: State<'_, SharedRuntime>,
    session_id: String,
    message: String,
    images: Option<Vec<serde_json::Value>>,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.touch(&session_id);
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.steer(message, images).await
}

#[tauri::command]
async fn send_follow_up(
    state: State<'_, SharedRuntime>,
    session_id: String,
    message: String,
    images: Option<Vec<serde_json::Value>>,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.touch(&session_id);
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.follow_up(message, images).await
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

// --- 会话切换后加载 (历史/统计/重命名) ---

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

// --- extension_ui_request 响应 ---

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

/// 统一工具权限审批响应 (Claude Code `can_use_tool` / ACP `session/request_permission` 共用)
#[tauri::command]
async fn respond_permission(
    state: State<'_, SharedRuntime>,
    session_id: String,
    request_id: String,
    allow: bool,
    reason: Option<String>,
    option_id: Option<String>,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    guard.touch(&session_id);
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime
        .respond_permission(request_id, allow, reason, option_id)
        .await
}

/// 运行中一键切换权限模式 (如 Claude Code: auto / manual / acceptEdits / plan / dontAsk / bypassPermissions)
#[tauri::command]
async fn set_permission_mode(
    state: State<'_, SharedRuntime>,
    session_id: String,
    mode: String,
) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    guard.touch(&session_id);
    let runtime = guard.runtimes.get_mut(&session_id).ok_or("session 不存在")?;
    runtime.set_permission_mode(mode).await
}

/// 动态拉取可透传的 /命令 候选, 无活跃会话时返回空列表而非报错
#[tauri::command]
async fn get_commands(state: State<'_, SharedRuntime>, session_id: String) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().await;
    match guard.runtimes.get_mut(&session_id) {
        Some(runtime) => runtime.get_commands().await,
        None => Ok(serde_json::json!({ "commands": [] })),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(Mutex::new(RuntimePool::new())) as SharedRuntime)
        .setup(|_app| {
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
            backends::list_available_agents,
            start_session, send_prompt, abort_session, stop_session,
            send_steer, send_follow_up,
            get_state, get_available_models, set_model, cycle_model,
            set_thinking_level, cycle_thinking_level, get_available_thinking_levels,
            get_entries, get_session_stats, set_session_name,
            send_extension_ui_response, respond_permission, set_permission_mode, get_commands,
            session_fs::list_projects_and_sessions, session_fs::delete_session_file,
            session_fs::read_file_for_context, session_fs::list_skills_and_packages,
            session_fs::get_session_file_mtime,
            session_fs::list_dir, session_fs::read_session_entries_public,
            session_fs::list_files_recursive,
            search::search_files,
            local_path::resolve_local_path, local_path::read_text_file,
            local_path::open_local_path, local_path::reveal_local_path, local_path::open_external_url,
            git::git_status, git::git_diff, git::git_branches, git::git_log, git::git_show,
            git::git_stage, git::git_unstage, git::git_commit, git::git_checkout,
            capture::capture_screenshot,
            attach::read_clipboard_attachments, attach::resolve_attachment_paths,
            token_stats::get_token_stats,
            behavior_stats::get_behavior_stats, behavior_stats::get_session_behavior,
            subagent_fleet::list_fleet_runs, subagent_fleet::read_fleet_run_detail,
            trellis_tasks::list_trellis_tasks, trellis_tasks::read_trellis_task_doc,
            models_config::read_models_config, models_config::write_models_config,
            settings_config::read_session_defaults, settings_config::write_session_defaults,
            provider_probe::probe_provider_models,
            discard_warm_runtime, app_version,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() != "main" {
                    return;
                }
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
