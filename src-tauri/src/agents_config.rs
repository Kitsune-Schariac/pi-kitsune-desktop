//! 多 Agent 运行时本地配置 (`~/.pi-kitsune/agents.json`):
//! - 各 CLI 可执行文件路径覆盖 (留空走 PATH)
//! - Claude Code 默认权限模式 (默认 `"auto"`)
//! - 预留 `customAcpAgents` 列表, 支持后续零代码配置扩展其他 ACP 兼容 CLI
//!
//! 写入采用同目录 `.tmp` + `rename` 原子替换; 缺失或损坏时回退默认值, 不阻塞启动。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

fn default_claude_permission_mode() -> String {
    "auto".to_string()
}

fn default_codex_permission_mode() -> String {
    "auto".to_string()
}

/// 预留: 自定义 ACP 兼容 Agent 预设 (如 Gemini CLI / OpenCode 等)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAcpAgent {
    pub id: String,
    pub label: String,
    pub badge: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsConfig {
    #[serde(default)]
    pub pi_path: Option<String>,
    #[serde(default)]
    pub claude_path: Option<String>,
    #[serde(default)]
    pub agy_path: Option<String>,
    #[serde(default)]
    pub codex_path: Option<String>,
    #[serde(default = "default_claude_permission_mode")]
    pub claude_default_permission_mode: String,
    #[serde(default = "default_codex_permission_mode")]
    pub codex_default_permission_mode: String,
    #[serde(default)]
    pub custom_acp_agents: Vec<CustomAcpAgent>,
}

impl Default for AgentsConfig {
    fn default() -> Self {
        Self {
            pi_path: None,
            claude_path: None,
            agy_path: None,
            codex_path: None,
            claude_default_permission_mode: default_claude_permission_mode(),
            codex_default_permission_mode: default_codex_permission_mode(),
            custom_acp_agents: Vec::new(),
        }
    }
}

impl AgentsConfig {
    /// 清洗空串为 `None`, 校验默认权限模式回落 `"auto"`。
    pub fn normalized(mut self) -> Self {
        let clean = |opt: Option<String>| {
            opt.map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        self.pi_path = clean(self.pi_path);
        self.claude_path = clean(self.claude_path);
        self.agy_path = clean(self.agy_path);
        self.codex_path = clean(self.codex_path);
        if !crate::backends::claude::CLAUDE_PERMISSION_MODES
            .contains(&self.claude_default_permission_mode.as_str())
        {
            self.claude_default_permission_mode = default_claude_permission_mode();
        }
        if !crate::backends::codex::protocol::CODEX_PERMISSION_MODES
            .contains(&self.codex_default_permission_mode.as_str())
        {
            self.codex_default_permission_mode = default_codex_permission_mode();
        }
        self
    }

    pub fn program_for(&self, kind: crate::backends::AgentKind) -> &str {
        match kind {
            crate::backends::AgentKind::Pi => self.pi_path.as_deref().unwrap_or("pi"),
            crate::backends::AgentKind::Claude => self.claude_path.as_deref().unwrap_or("claude"),
            crate::backends::AgentKind::Agy => self.agy_path.as_deref().unwrap_or("agy"),
            crate::backends::AgentKind::Codex => self.codex_path.as_deref().unwrap_or("codex"),
        }
    }
}

fn config_path() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法确定用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".pi-kitsune").join("agents.json"))
}

pub fn load_from_path(path: &Path) -> AgentsConfig {
    let Ok(text) = std::fs::read_to_string(path) else {
        return AgentsConfig::default();
    };
    serde_json::from_str::<AgentsConfig>(&text)
        .map(AgentsConfig::normalized)
        .unwrap_or_default()
}

pub fn save_to_path(path: &Path, cfg: AgentsConfig) -> Result<AgentsConfig, String> {
    let clean = cfg.normalized();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&clean).map_err(|e| format!("序列化配置失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入临时配置失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换配置文件失败: {e}")
    })?;
    Ok(clean)
}

/// 内部便捷读取: 永不失败, 缺文件/坏文件回退默认配置。
pub fn load_agents_config() -> AgentsConfig {
    config_path()
        .map(|p| load_from_path(&p))
        .unwrap_or_default()
}

#[tauri::command]
pub fn read_agents_config() -> Result<AgentsConfig, String> {
    Ok(load_agents_config())
}

#[tauri::command]
pub fn write_agents_config(config: AgentsConfig) -> Result<AgentsConfig, String> {
    let path = config_path()?;
    save_to_path(&path, config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_normalization() {
        let dir = std::env::temp_dir().join(format!(
            "kitsune-agents-cfg-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("agents.json");

        // 缺文件返回默认
        let def = load_from_path(&path);
        assert_eq!(def.claude_default_permission_mode, "auto");
        assert_eq!(def.codex_default_permission_mode, "auto");
        assert_eq!(def.program_for(crate::backends::AgentKind::Agy), "agy");
        assert_eq!(def.program_for(crate::backends::AgentKind::Codex), "codex");

        // 空串归一化为 None, 非法权限模式回退 auto
        let saved = save_to_path(
            &path,
            AgentsConfig {
                pi_path: Some("   ".into()),
                claude_path: Some(r"C:\tools\claude.exe".into()),
                agy_path: Some(r"C:\tools\agy.exe".into()),
                codex_path: Some(r"C:\tools\codex.exe".into()),
                claude_default_permission_mode: "invalid".into(),
                codex_default_permission_mode: "invalid".into(),
                custom_acp_agents: vec![CustomAcpAgent {
                    id: "gemini".into(),
                    label: "Gemini CLI".into(),
                    badge: "GEM".into(),
                    command: "gemini".into(),
                    args: vec!["--experimental-acp".into()],
                }],
            },
        )
        .unwrap();
        assert_eq!(saved.pi_path, None);
        assert_eq!(saved.claude_default_permission_mode, "auto");
        assert_eq!(saved.codex_default_permission_mode, "auto");

        let reloaded = load_from_path(&path);
        assert_eq!(reloaded, saved);
        assert_eq!(
            reloaded.program_for(crate::backends::AgentKind::Agy),
            r"C:\tools\agy.exe"
        );
        assert_eq!(
            reloaded.program_for(crate::backends::AgentKind::Codex),
            r"C:\tools\codex.exe"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
