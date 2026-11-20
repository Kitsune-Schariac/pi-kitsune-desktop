//! Agent CLI 后端抽象层: 统一类型、能力声明、标准事件协议与静态分发运行时。
//!
//! 设计约束:
//! - 所有 CLI 协议差异封闭在各自子模块 (`backends/pi/`, 后续 `claude/` / `acp/`)。
//! - 前端仅消费 `UnifiedEvent` (经 `agent_event` 频道) 与 `AgentCapabilities`。
//! - 采用 `enum AgentRuntime` 静态分发: 零额外 crate 依赖、零装箱开销、编译期穷尽校验。

pub mod pi;
pub mod process;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 支持的 Agent CLI 标识 (跨 Rust / TS 契约统一小写字符串)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Pi,
    Claude,
    Agy,
}

impl AgentKind {
    pub fn pi_default() -> Self {
        Self::Pi
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Pi => "Pi",
            Self::Claude => "Claude Code",
            Self::Agy => "Antigravity",
        }
    }

    pub fn badge(self) -> &'static str {
        match self {
            Self::Pi => "PI",
            Self::Claude => "CC",
            Self::Agy => "AGY",
        }
    }

    pub fn capabilities(self) -> AgentCapabilities {
        match self {
            Self::Pi => AgentCapabilities {
                steer: true,
                follow_up: true,
                hot_model_switch: true,
                thinking_level: true,
                permission_modes: Vec::new(),
                extension_ui: true,
                tool_approval: false,
                remote_commands: true,
                session_rename: true,
                fleet_view: true,
                models_editor: true,
            },
            Self::Claude => AgentCapabilities {
                steer: false,
                follow_up: false,
                hot_model_switch: true,
                thinking_level: true,
                permission_modes: vec![
                    "auto".into(),
                    "manual".into(),
                    "acceptEdits".into(),
                    "plan".into(),
                    "dontAsk".into(),
                    "bypassPermissions".into(),
                ],
                extension_ui: false,
                tool_approval: true,
                remote_commands: false,
                session_rename: false,
                fleet_view: false,
                models_editor: false,
            },
            Self::Agy => AgentCapabilities {
                steer: false,
                follow_up: false,
                hot_model_switch: false,
                thinking_level: false,
                permission_modes: Vec::new(),
                extension_ui: false,
                tool_approval: true,
                remote_commands: false,
                session_rename: false,
                fleet_view: false,
                models_editor: false,
            },
        }
    }
}

/// 单个 Agent 后端的能力声明: 前端按此条件渲染专属控件, 不支持的优雅隐藏/降级。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub steer: bool,
    pub follow_up: bool,
    pub hot_model_switch: bool,
    pub thinking_level: bool,
    pub permission_modes: Vec<String>,
    pub extension_ui: bool,
    pub tool_approval: bool,
    pub remote_commands: bool,
    pub session_rename: bool,
    pub fleet_view: bool,
    pub models_editor: bool,
}

/// 前端展示的 Agent 运行时描述 (新建会话选择菜单 / 运行时状态)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub kind: AgentKind,
    pub label: String,
    pub badge: String,
    pub installed: bool,
    pub version: Option<String>,
    pub implemented: bool,
    pub available: bool,
    pub reason: Option<String>,
    pub capabilities: AgentCapabilities,
}

/// 内容块类型 (用于区分正文 / 思考 / 工具调用参数生成阶段)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentBlockKind {
    Text,
    Thinking,
    ToolCall,
}

/// 单条 assistant 消息结算后的用量。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost: Option<f64>,
}

/// 通知级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotifyLevel {
    Info,
    Warning,
    Error,
}

/// Rust → 前端统一事件协议 (通过 `agent_event` 通道推送 `{ sessionId, event }`)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UnifiedEvent {
    TurnStart,
    #[serde(rename_all = "camelCase")]
    AssistantStart {
        message_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ContentBlockStart {
        block: ContentBlockKind,
    },
    TextDelta {
        delta: String,
    },
    ThinkingDelta {
        delta: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallDelta {
        has_delta: bool,
    },
    LiveUsage {
        input: u64,
        output: u64,
    },
    #[serde(rename_all = "camelCase")]
    AssistantEnd {
        usage: Option<MessageUsage>,
        stop_reason: Option<String>,
        error_message: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    #[serde(rename_all = "camelCase")]
    ToolUpdate {
        tool_call_id: String,
        partial_result: Value,
    },
    #[serde(rename_all = "camelCase")]
    ToolEnd {
        tool_call_id: String,
        is_error: bool,
        result: Value,
    },
    #[serde(rename_all = "camelCase")]
    RetryStart {
        attempt: u64,
        max_attempts: u64,
        error_message: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RetryEnd {
        success: bool,
        attempt: u64,
        final_error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    QueueUpdate {
        steering: Vec<String>,
        follow_up: Vec<String>,
    },
    UiRequest {
        request: Value,
    },
    #[serde(rename_all = "camelCase")]
    Notice {
        id: Option<String>,
        notify_type: NotifyLevel,
        message: String,
        from_extension: bool,
    },
    TurnSettled,
    #[serde(rename_all = "camelCase")]
    ProcessExit {
        agent_kind: AgentKind,
        message: String,
    },
}

/// 活跃会话后端的静态分发容器。
pub enum AgentRuntime {
    Pi(pi::PiBackend),
}

impl AgentRuntime {
    pub fn kind(&self) -> AgentKind {
        match self {
            Self::Pi(_) => AgentKind::Pi,
        }
    }

    pub fn capabilities(&self) -> AgentCapabilities {
        self.kind().capabilities()
    }

    pub async fn send_prompt(
        &mut self,
        message: String,
        images: Option<Vec<Value>>,
    ) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.send_prompt(message, images).await,
        }
    }

    pub async fn abort(&mut self) -> Result<(), String> {
        match self {
            Self::Pi(rt) => rt.abort().await,
        }
    }

    pub async fn steer(&mut self, message: String, images: Option<Vec<Value>>) -> Result<(), String> {
        match self {
            Self::Pi(rt) => rt.steer(message, images).await,
        }
    }

    pub async fn follow_up(
        &mut self,
        message: String,
        images: Option<Vec<Value>>,
    ) -> Result<(), String> {
        match self {
            Self::Pi(rt) => rt.follow_up(message, images).await,
        }
    }

    pub async fn get_state(&mut self) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.get_state().await,
        }
    }

    pub async fn get_available_models(&mut self) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.get_available_models().await,
        }
    }

    pub async fn set_model(&mut self, provider: String, model_id: String) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.set_model(provider, model_id).await,
        }
    }

    pub async fn cycle_model(&mut self) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.cycle_model().await,
        }
    }

    pub async fn set_thinking_level(&mut self, level: String) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.set_thinking_level(level).await,
        }
    }

    pub async fn cycle_thinking_level(&mut self) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.cycle_thinking_level().await,
        }
    }

    pub async fn get_available_thinking_levels(&mut self) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.get_available_thinking_levels().await,
        }
    }

    pub async fn get_entries(&mut self) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.get_entries().await,
        }
    }

    pub async fn get_session_stats(&mut self) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.get_session_stats().await,
        }
    }

    pub async fn set_session_name(&mut self, name: String) -> Result<(), String> {
        match self {
            Self::Pi(rt) => rt.set_session_name(name).await,
        }
    }

    pub async fn send_extension_ui_response(
        &mut self,
        id: String,
        payload: Value,
    ) -> Result<(), String> {
        match self {
            Self::Pi(rt) => rt.send_extension_ui_response(id, payload).await,
        }
    }

    pub async fn get_commands(&mut self) -> Result<Value, String> {
        match self {
            Self::Pi(rt) => rt.get_commands().await,
        }
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        match self {
            Self::Pi(rt) => rt.stop().await,
        }
    }
}

/// 并发探测本机已注册 Agent CLI 的安装与可用状态 (不阻塞 UI, Windows 严格抑窗)。
#[tauri::command]
pub async fn list_available_agents() -> Result<Vec<AgentDescriptor>, String> {
    let (pi_ver, claude_ver, agy_ver) = tokio::join!(
        process::probe_cli_version("pi", &["--version"], 4),
        process::probe_cli_version("claude", &["--version"], 4),
        process::probe_cli_version("agy", &["--version"], 4),
    );

    let build = |kind: AgentKind, version: Option<String>, implemented: bool, cmd_name: &str| {
        let installed = version.is_some();
        let available = installed && implemented;
        let reason = if !implemented {
            Some(if installed {
                "即将支持".to_string()
            } else {
                format!("未检测到 {cmd_name} · 即将支持")
            })
        } else if !installed {
            Some(format!("未检测到 {cmd_name} 命令"))
        } else {
            None
        };
        AgentDescriptor {
            kind,
            label: kind.label().to_string(),
            badge: kind.badge().to_string(),
            installed,
            version,
            implemented,
            available,
            reason,
            capabilities: kind.capabilities(),
        }
    };

    Ok(vec![
        build(AgentKind::Pi, pi_ver, true, "pi"),
        build(AgentKind::Claude, claude_ver, false, "claude"),
        build(AgentKind::Agy, agy_ver, false, "agy"),
    ])
}
