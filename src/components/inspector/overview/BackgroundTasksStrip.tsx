import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Bot, Clock, ListOrdered, Radio, SquareTerminal } from "lucide-react";
import { useSessionStore } from "../../../store/session";
import { useFleetStore } from "../../../store/fleet";
import { useUiStore } from "../../../store/ui";
import { fmtMs } from "../../../lib/telemetry";
import { summarizeStep } from "../../../lib/timeline";

/**
 * 后台任务视图: 聚合展示全应用实时后台负载。
 * 1. 其他正在运行 (isStreaming) 或有未读完成的后台会话 → 点击一键切换
 * 2. 正在运行中的 Subagent 后台产物 → 实时耗时跳动, 点击直达「代理」页签对应 Run
 * 3. 当前会话的运行中工具 + steering / followUp 排队消息
 * 全部空闲时收拢为极简一行, 不占首屏空间。
 */
export function BackgroundTasksStrip() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const openStep = useUiStore((s) => s.openStep);
  const runs = useFleetStore((s) => s.runs);
  const requestOpenRun = useFleetStore((s) => s.requestOpenRun);

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;

  // 其他后台活跃或未读会话
  const bgSessions = useMemo(
    () =>
      Object.values(sessions).filter(
        (s) => s.sessionId !== activeSessionId && (s.isStreaming || s.hasUnread),
      ),
    [sessions, activeSessionId],
  );

  // 活跃 Subagent 后台产物
  const activeRuns = useMemo(() => runs.filter((r) => r.active), [runs]);

  // 当前会话运行中的工具步骤
  const runningTools = useMemo(
    () => (activeSession?.entries ?? []).filter((e) => e.kind === "tool" && e.status === "running"),
    [activeSession?.entries],
  );

  const steeringQueue = activeSession?.steeringQueue ?? [];
  const followUpQueue = activeSession?.followUpQueue ?? [];
  const queueCount = steeringQueue.length + followUpQueue.length;

  const totalCount = bgSessions.length + activeRuns.length + runningTools.length + queueCount;

  // 仅存在计时任务时开启 1s tick, 空闲零定时器开销
  const hasTimed = activeRuns.length > 0 || runningTools.length > 0;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!hasTimed) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasTimed]);

  if (totalCount === 0) {
    return (
      <div className="tel-card flex items-center justify-between py-2">
        <span className="tel-title">
          <Radio className="h-[13px] w-[13px] text-fg-4" />
          后台任务
        </span>
        <span className="text-meta text-fg-4">全部空闲</span>
      </div>
    );
  }

  return (
    <div className="tel-card">
      <div className="tel-head">
        <span className="tel-title">
          <Radio className="h-[13px] w-[13px] text-fg-3" />
          后台任务
        </span>
        <span className="flex items-center gap-2 font-mono text-meta tabular-nums text-fg-2">
          {(activeRuns.length > 0 || runningTools.length > 0 || bgSessions.some((s) => s.isStreaming)) && (
            <span className="live-dot" />
          )}
          {totalCount} 项
        </span>
      </div>

      <div className="mt-2 space-y-1">
        {/* 当前会话运行中工具 */}
        {runningTools.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => openStep(t.id)}
            className="flex w-full items-center gap-2 rounded-sm bg-well px-2 py-2 text-left text-meta transition-colors duration-fast ease-out hover:bg-hover"
          >
            <span className="live-dot" />
            <SquareTerminal className="h-3 w-3 shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1 truncate font-mono text-fg" title={summarizeStep(t)}>
              {t.toolName} · {summarizeStep(t)}
            </span>
            {t.startedAt && (
              <span className="shrink-0 font-mono tabular-nums text-fg-4">
                {fmtMs(Math.max(0, now - t.startedAt))}
              </span>
            )}
          </button>
        ))}

        {/* 活跃 Subagent 后台产物 */}
        {activeRuns.map((run) => {
          const step = run.steps[run.current_step] ?? run.steps[run.steps.length - 1];
          const label = step?.agent || run.run_id.slice(0, 8);
          return (
            <button
              key={run.run_id}
              type="button"
              onClick={() => requestOpenRun(run.dir)}
              className="flex w-full items-center gap-2 rounded-sm bg-well px-2 py-2 text-left text-meta transition-colors duration-fast ease-out hover:bg-hover"
              title={`查看代理 ${label} 详情`}
            >
              <span className="live-dot" />
              <Bot className="h-3 w-3 shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1 truncate text-fg">
                {label}
                {step?.active_tools?.[0] ? (
                  <span className="ml-1 font-mono text-fg-3">· {step.active_tools[0].name}</span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-fg-4">
                {fmtMs(Math.max(0, now - run.started_at))}
              </span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-fg-4" />
            </button>
          );
        })}

        {/* 其他后台运行/未读会话 */}
        {bgSessions.map((s) => {
          const proj = s.cwd.split(/[\\/]/).pop() || s.cwd;
          const title = s.sessionName || proj;
          return (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => setActiveSession(s.sessionId)}
              className="flex w-full items-center gap-2 rounded-sm bg-well px-2 py-2 text-left text-meta transition-colors duration-fast ease-out hover:bg-hover"
              title={`切换到会话: ${s.cwd}`}
            >
              {s.isStreaming ? (
                <span className="live-dot" />
              ) : (
                <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />
              )}
              <Clock className="h-3 w-3 shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
              <span className="shrink-0 text-fg-4">
                {s.isStreaming ? "运行中" : "已完成"}
              </span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-fg-4" />
            </button>
          );
        })}

        {/* 当前会话排队消息 */}
        {steeringQueue.map((msg, i) => (
          <div
            key={`steer-${i}`}
            className="flex items-center gap-2 rounded-sm bg-well px-2 py-2 text-meta"
            title={msg}
          >
            <ListOrdered className="h-3 w-3 shrink-0 text-warn" />
            <span className="shrink-0 text-warn">插队</span>
            <span className="min-w-0 flex-1 truncate text-fg-2">{msg}</span>
          </div>
        ))}
        {followUpQueue.map((msg, i) => (
          <div
            key={`follow-${i}`}
            className="flex items-center gap-2 rounded-sm bg-well px-2 py-2 text-meta"
            title={msg}
          >
            <ListOrdered className="h-3 w-3 shrink-0 text-fg-3" />
            <span className="shrink-0 text-fg-3">待续</span>
            <span className="min-w-0 flex-1 truncate text-fg-2">{msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
