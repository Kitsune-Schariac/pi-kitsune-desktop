import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useAgentsStore } from "../store/agents";
import { AgentBadge } from "./AgentBadge";
import type { AgentDescriptor, AgentKind } from "../lib/agent";

/**
 * 轻量新建会话 Agent 选择菜单:
 * - fixed 坐标弹出, 视口边缘自动回弹
 * - 自动将上次使用的 Agent 置顶并标记「上次」
 * - 支持 ↑↓ 导航 (自动跳过不可用项)、Enter 确认、Esc 或外部点击关闭
 * - 不可用项置灰并显示原因 (如「即将支持」/「未检测到命令」), 不可误触
 */
export function AgentPickerMenu({
  x,
  y,
  title = "选择 Agent 新建会话",
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  title?: string;
  onPick: (kind: AgentKind) => void;
  onClose: () => void;
}) {
  const agents = useAgentsStore((s) => s.agents);
  const lastAgent = useAgentsStore((s) => s.lastAgent);
  const rememberAgent = useAgentsStore((s) => s.rememberAgent);

  // 上次使用的 Agent 排首位, 其余保持注册顺序
  const ordered = useMemo<AgentDescriptor[]>(() => {
    const top = agents.find((a) => a.kind === lastAgent);
    const rest = agents.filter((a) => a.kind !== lastAgent);
    return top ? [top, ...rest] : agents;
  }, [agents, lastAgent]);

  const firstSelectable = useMemo(() => {
    const idx = ordered.findIndex((a) => a.available);
    return idx >= 0 ? idx : 0;
  }, [ordered]);

  const [focusIdx, setFocusIdx] = useState(firstSelectable);

  useEffect(() => {
    setFocusIdx(firstSelectable);
  }, [firstSelectable]);

  const choose = (item: AgentDescriptor) => {
    if (!item.available) return;
    rememberAgent(item.kind);
    onClose();
    onPick(item.kind);
  };

  useEffect(() => {
    const onOutside = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const n = ordered.length;
        if (n === 0) return;
        let idx = focusIdx;
        for (let step = 0; step < n; step++) {
          idx = (idx + delta + n) % n;
          if (ordered[idx].available) {
            setFocusIdx(idx);
            return;
          }
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const target = ordered[focusIdx];
        if (target?.available) choose(target);
      }
    };
    window.addEventListener("click", onOutside);
    window.addEventListener("contextmenu", onOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onOutside);
      window.removeEventListener("contextmenu", onOutside);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, focusIdx, onClose]);

  const menuW = 248;
  const menuH = 40 + ordered.length * 42;
  const left = Math.max(8, Math.min(x, window.innerWidth - menuW - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - menuH - 8));

  return (
    <div
      data-overlay
      className="popover fixed z-50 p-1 view-in-soft"
      style={{ left, top, width: menuW }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
      aria-label={title}
    >
      <div className="px-2 py-1 text-meta text-fg-4">{title}</div>
      <div className="space-y-1">
        {ordered.map((agent, idx) => {
          const isLast = agent.kind === lastAgent;
          const isFocused = idx === focusIdx && agent.available;
          return (
            <button
              key={agent.kind}
              type="button"
              role="menuitem"
              disabled={!agent.available}
              onMouseEnter={() => {
                if (agent.available) setFocusIdx(idx);
              }}
              onClick={() => choose(agent)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition duration-fast ease-out ${
                !agent.available
                  ? "cursor-not-allowed opacity-50"
                  : isFocused
                    ? "bg-hover text-fg"
                    : "text-fg-2 hover:bg-hover hover:text-fg"
              }`}
            >
              <AgentBadge kind={agent.kind} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="truncate text-body font-medium">{agent.label}</span>
                  {isLast && agent.available && (
                    <span className="rounded bg-well px-1 text-[10px] text-fg-4">上次</span>
                  )}
                </div>
                <div className="truncate text-meta text-fg-4">
                  {agent.available
                    ? agent.version
                      ? /^\d/.test(agent.version)
                        ? `v${agent.version}`
                        : agent.version
                      : "已就绪"
                    : agent.reason || "暂不可用"}
                </div>
              </div>
              {isLast && agent.available && <Check className="h-4 w-4 shrink-0 text-fg-3" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
