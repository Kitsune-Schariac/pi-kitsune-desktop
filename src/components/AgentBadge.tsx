import { AGENT_META, normalizeAgentKind, type AgentKind } from "../lib/agent";

// 严格遵循 tailwind.config.ts 令牌体系: 组件内不写字面颜色, 全部基于日/夜语义 CSS 变量
const AGENT_STYLE: Record<AgentKind, string> = {
  pi: "border-line bg-well text-fg-3",
  claude: "border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_12%,transparent)] text-warn",
  agy: "border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-accent",
  codex: "border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] text-ok",
};

/**
 * 紧凑 Agent 徽标 (PI / CC / AGY / CDX): 用于侧栏会话行、空状态最近列表与会话顶栏。
 * 单行不撑高, 日间/夜间模式随语义变量自动适配。
 */
export function AgentBadge({
  kind,
  size = "sm",
  className = "",
}: {
  kind?: AgentKind | string | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const k = normalizeAgentKind(kind);
  const meta = AGENT_META[k];
  const sizing =
    size === "md"
      ? "h-5 px-2 text-meta leading-none"
      : "h-4 px-1 text-[10px] leading-none";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded border font-mono font-medium tracking-tight ${sizing} ${AGENT_STYLE[k]} ${className}`}
      title={meta.label}
    >
      {meta.badge}
    </span>
  );
}
