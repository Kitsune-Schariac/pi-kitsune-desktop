import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, RefreshCw, Save, Shield, Terminal, XCircle } from "lucide-react";
import { useAgentsStore } from "../../store/agents";
import { AgentBadge } from "../AgentBadge";
import { Badge, Button, Card, Input, Select } from "../ui";
import { PERMISSION_MODE_LABELS, type AgentKind } from "../../lib/agent";

interface CustomAcpAgent {
  id: string;
  label: string;
  badge: string;
  command: string;
  args: string[];
}

interface AgentsConfig {
  piPath: string | null;
  claudePath: string | null;
  agyPath: string | null;
  codexPath: string | null;
  claudeDefaultPermissionMode: string;
  codexDefaultPermissionMode: string;
  customAcpAgents: CustomAcpAgent[];
}

const CLAUDE_MODES = ["auto", "manual", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const CODEX_MODES = ["auto", "manual", "read-only", "full-access"];

const PATH_FIELD: Record<AgentKind, "piPath" | "claudePath" | "agyPath" | "codexPath"> = {
  pi: "piPath",
  claude: "claudePath",
  agy: "agyPath",
  codex: "codexPath",
};

const DEFAULT_CMD: Record<AgentKind, string> = {
  pi: "pi (从 PATH 解析)",
  claude: "claude (从 PATH 解析)",
  agy: "agy (从 PATH 解析，将运行 agy acp)",
  codex: "codex (从 PATH 解析，将运行 codex app-server)",
};

/**
 * 设置窗「Agent 运行时」子页:
 * 展示本机探测结果、版本号、能力摘要、自定义可执行文件路径覆盖及 Claude 默认权限模式。
 * 遵循项目 4px 整档间距与语义令牌体系。
 */
export function AgentsPanel() {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const loadAgents = useAgentsStore((s) => s.loadAgents);

  const [cfg, setCfg] = useState<AgentsConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    invoke<AgentsConfig>("read_agents_config")
      .then(setCfg)
      .catch((e) => setMessage({ kind: "err", text: `读取配置失败: ${String(e)}` }));
    void loadAgents();
  }, [loadAgents]);

  const handleSave = async () => {
    if (!cfg || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await invoke<AgentsConfig>("write_agents_config", { config: cfg });
      setCfg(saved);
      await loadAgents();
      setMessage({ kind: "ok", text: "已保存配置并重新探测本机 CLI" });
    } catch (e) {
      setMessage({ kind: "err", text: `保存失败: ${String(e)}` });
    }
    setSaving(false);
  };

  return (
    <div className="mx-auto max-w-[920px] space-y-6 px-8 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-fg-3">
          配置本地 Agent CLI 路径覆盖与默认启动偏好。留空表示自动从系统 PATH 解析。
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={() => void loadAgents()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            重新检测
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={!cfg || saving}>
            <Save className="h-4 w-4" />
            {saving ? "保存中…" : "保存并检测"}
          </Button>
        </div>
      </div>

      {message && (
        <div
          className={`rounded-md border px-4 py-2 text-body ${
            message.kind === "ok"
              ? "border-line bg-card text-ok"
              : "border-[color-mix(in_srgb,var(--err)_35%,transparent)] bg-[color-mix(in_srgb,var(--err)_8%,transparent)] text-err"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="space-y-4">
        {agents.map((agent) => {
          const field = PATH_FIELD[agent.kind];
          const pathVal = cfg?.[field] ?? "";
          return (
            <Card key={agent.kind} padded className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AgentBadge kind={agent.kind} size="md" />
                  <span className="text-lead font-semibold text-fg">{agent.label}</span>
                  {agent.version && (
                    <span className="font-mono text-label text-fg-4">
                      {agent.version}
                    </span>
                  )}
                </div>
                <Badge tone={agent.available ? "ok" : "warn"}>
                  {agent.available ? (
                    <>
                      <CheckCircle2 className="h-3 w-3" />
                      已就绪
                    </>
                  ) : (
                    <>
                      <XCircle className="h-3 w-3" />
                      {agent.reason || "未检测到"}
                    </>
                  )}
                </Badge>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="flex items-center gap-1 text-label text-fg-3">
                    <Terminal className="h-3 w-3 text-fg-4" />
                    可执行文件路径（可选覆盖）
                  </label>
                  <Input
                    value={pathVal}
                    onChange={(e) =>
                      setCfg((prev) =>
                        prev ? { ...prev, [field]: e.target.value || null } : prev,
                      )
                    }
                    placeholder={DEFAULT_CMD[agent.kind]}
                  />
                </div>

                {agent.kind === "claude" && cfg && (
                  <div className="space-y-1">
                    <label className="flex items-center gap-1 text-label text-fg-3">
                      <Shield className="h-3 w-3 text-fg-4" />
                      新会话默认权限模式
                    </label>
                    <Select
                      value={cfg.claudeDefaultPermissionMode}
                      onChange={(mode) =>
                        setCfg((prev) =>
                          prev ? { ...prev, claudeDefaultPermissionMode: mode } : prev,
                        )
                      }
                      className="w-full"
                      options={CLAUDE_MODES.map((m) => ({
                        value: m,
                        label: PERMISSION_MODE_LABELS[m] ?? m,
                      }))}
                    />
                  </div>
                )}

                {agent.kind === "codex" && cfg && (
                  <div className="space-y-1">
                    <label className="flex items-center gap-1 text-label text-fg-3">
                      <Shield className="h-3 w-3 text-fg-4" />
                      新会话默认权限模式
                    </label>
                    <Select
                      value={cfg.codexDefaultPermissionMode}
                      onChange={(mode) =>
                        setCfg((prev) =>
                          prev ? { ...prev, codexDefaultPermissionMode: mode } : prev,
                        )
                      }
                      className="w-full"
                      options={CODEX_MODES.map((m) => ({
                        value: m,
                        label: PERMISSION_MODE_LABELS[m] ?? m,
                      }))}
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2 text-meta text-fg-4">
                {agent.capabilities.hotModelSwitch && <Badge>模型热切换</Badge>}
                {agent.capabilities.steer && (
                  <Badge>{agent.capabilities.followUp ? "Steer / FollowUp" : "运行中 Steer"}</Badge>
                )}
                {agent.capabilities.toolApproval && <Badge>交互权限审批</Badge>}
                {agent.capabilities.permissionModes.length > 0 && <Badge>权限模式切换</Badge>}
                {agent.capabilities.fleetView && <Badge>Subagent 舰队</Badge>}
                {agent.kind === "agy" && <Badge>ACP v1 协议</Badge>}
                {agent.kind === "codex" && <Badge>App Server 协议</Badge>}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
