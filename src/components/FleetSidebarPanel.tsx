// Subagent 舰队侧栏面板: 会话区右侧内嵌面板, 三态视图机 fleet → run → subsession。
// 交互骨架对齐 GitSidebarPanel (右侧内嵌圆角卡片、左缘拖拽调宽、Esc 层级)。
// 数据源: store/fleet.ts 2s 轮询 status.json (面板开着才轮询), 详情/子会话懒加载。
// 视觉走皮肤 CSS token (surface/border/primary/red), 禁 backdrop-filter/emoji/硬编码色。
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Radar, Bot, Cpu, Clock, Coins, ListChecks, ChevronRight, ChevronLeft,
  X, RefreshCw, Loader2, AlertCircle, FileText,
} from "lucide-react";
import { useFleetStore } from "../store/fleet";
import type { FleetRunSummary, FleetStepSummary } from "../store/fleet";
import { mapHistoryEntries, type ChatEntry } from "../store/session";
import { MessageItem } from "./MessageItem";
import { ToolCallCard } from "./ToolCallCard";
import { NotificationItem } from "./NotificationItem";

// 三态视图: fleet 为顶层, run 从 fleet 进入 (点 run 卡片), subsession 从 run 进入 (点 step)。
// subsession→run, run→fleet 是 Esc 与 ‹返回的回退路径; fleet 不响应 Esc (常驻面板)。
type View =
  | { kind: "fleet" }
  | { kind: "run"; dir: string }
  | { kind: "subsession"; dir: string; sessionFile: string; title: string };

// 侧栏宽度: 默认紧凑; 进入 run 视图自动拉宽给 recentOutput 可读空间。
// 用户手动拖过后以用户为准, 不再自动拉 (userResizedRef); 双击手柄复位并恢复自动拉宽资格。
const DEFAULT_W = 360;
const AUTO_RUN_W = 540;
const MIN_W = 300;
const MAX_W = 760;

// 耗时 ms → "12s" / "2m15s" / "1h3m" (紧凑, tabular-nums 对齐)
function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// token 大数压缩: 12.3k / 1.2M
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

// cost: $0 / $0.0098 / $16.87
function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// epoch ms → 时:分:秒 (相对当天, 列表紧凑, 不带日期)
function fmtTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

// 状态灯: 活动 = primary 呼吸 (animate-pulse 2s); failed = 固定红; 完成 = 中性; 未知 = 灰。
// 红是危险语义固定色 (spec 保留), 其余走皮肤 primary/neutral (随主题翻转)
function StatusDot({ state, active }: { state: string; active: boolean }) {
  if (active) {
    return (
      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-[rgb(var(--primary-500))] animate-pulse" />
    );
  }
  const t = (state || "").toLowerCase();
  if (["failed", "error", "aborted"].includes(t)) {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-500" />;
  }
  if (["complete", "completed", "success", "succeeded", "done"].includes(t)) {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-neutral-500" />;
  }
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-neutral-300" />;
}

interface Props {
  onClose: () => void;
}

export function FleetSidebarPanel({ onClose }: Props) {
  const runs = useFleetStore((s) => s.runs);
  const loading = useFleetStore((s) => s.loading);
  const lastError = useFleetStore((s) => s.lastError);
  const refresh = useFleetStore((s) => s.refresh);
  const startPolling = useFleetStore((s) => s.startPolling);
  const stopPolling = useFleetStore((s) => s.stopPolling);
  const detail = useFleetStore((s) => s.detail);
  const detailLoading = useFleetStore((s) => s.detailLoading);
  const detailError = useFleetStore((s) => s.detailError);
  const detailDir = useFleetStore((s) => s.detailDir);
  const openRunDetail = useFleetStore((s) => s.openRunDetail);
  const closeRunDetail = useFleetStore((s) => s.closeRunDetail);

  const [view, setView] = useState<View>({ kind: "fleet" });
  const [width, setWidth] = useState(DEFAULT_W);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);
  const userResizedRef = useRef(false);
  // 实时耗时每秒重算: 用一个每秒递增的 tick 触发活动 run 耗时跳动 (tabular-nums 不抖版式)
  const [now, setNow] = useState(Date.now());

  // 轮询生命周期: 面板挂载即开始 (引用计数), 卸载停。run/subsession 态轮询继续,
  // 活动区状态随轮询实时更新。实时耗时 tick 每秒推进 (与轮询独立, 耗时秒级跳动够)
  useEffect(() => {
    startPolling();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopPolling();
      clearInterval(tick);
    };
  }, [startPolling, stopPolling]);

  // 进入 run 视图拉详情 (events), 离开清掉 (防残留干扰下次进入)
  useEffect(() => {
    if (view.kind === "run") {
      openRunDetail(view.dir);
    } else {
      closeRunDetail();
    }
  }, [view, openRunDetail, closeRunDetail]);

  // Esc 层级: subsession → run, run → fleet, fleet 不响应 (常驻面板)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (view.kind === "subsession") {
        setView({ kind: "run", dir: view.dir });
      } else if (view.kind === "run") {
        setView({ kind: "fleet" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  // 进入 run 视图自动拉宽 (recentOutput 单列在窄栏里太挤); 返回 fleet 不缩回避免往复跳动。
  // 用户拖过则以用户为准 (依赖只有 view.kind)
  useEffect(() => {
    if (view.kind === "run" && !userResizedRef.current && width < AUTO_RUN_W) {
      setWidth(AUTO_RUN_W);
    }
  }, [view.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // 左缘拖拽调宽 (面板在右侧, 向左拖 = 变宽)。监听挂 window 保证移出热区仍跟手。
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, w: width };
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const s = dragStartRef.current;
      if (!s) return;
      userResizedRef.current = true;
      setWidth(Math.min(MAX_W, Math.max(MIN_W, s.w - (ev.clientX - s.x))));
    };
    const onUp = () => {
      dragStartRef.current = null;
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // run 视图对应的 summary (从轮询 runs 里按 dir 找, 步骤随轮询实时更新)
  const runSummary = useMemo<FleetRunSummary | null>(
    () => (view.kind === "run" ? runs.find((r) => r.dir === view.dir) ?? null : null),
    [runs, view],
  );
  const activeRuns = useMemo(() => runs.filter((r) => r.active), [runs]);
  const historyRuns = useMemo(
    () => runs.filter((r) => !r.active).slice(0, 10), // 历史区取最近 10 个
    [runs],
  );

  return (
    <>
      <div
        className="relative flex h-full shrink-0 flex-col py-2 pr-2"
        style={{ width, transition: dragging ? "none" : "width 160ms ease-out" }}
      >
        {/* 拖拽手柄: 左缘窄热区; 双击复位默认宽 */}
        <div
          onMouseDown={startResize}
          onDoubleClick={() => { userResizedRef.current = false; setWidth(DEFAULT_W); }}
          className="group absolute bottom-2 left-0 top-2 z-10 flex w-1.5 cursor-col-resize items-center justify-center"
          title="拖动调整宽度 · 双击复位"
        >
          <div
            className={`h-10 w-[3px] rounded-full transition ${
              dragging ? "bg-[rgb(var(--primary-500))]" : "bg-transparent group-hover:bg-[rgb(var(--border-strong))]"
            }`}
          />
        </div>
        <aside className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--surface-base)/var(--chat-alpha))] shadow-sm">
          {/* header: 三态各异。fleet = 标题+刷新+收起; run = ‹返回+runId+state; subsession = ‹返回+只读横幅 */}
          {view.kind === "fleet" ? (
            <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <Radar className="h-4 w-4 shrink-0 text-neutral-500" />
                <span className="text-sm font-medium">舰队</span>
                {runs.length > 0 && (
                  <span className="text-xs text-neutral-400">· {runs.length}</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => void refresh()}
                  disabled={loading}
                  className="rounded-md p-1 text-neutral-400 transition hover:bg-neutral-200/70 hover:text-neutral-700 disabled:opacity-40"
                  title="刷新"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                </button>
                <button
                  onClick={onClose}
                  className="rounded-md p-1 text-neutral-400 transition hover:bg-neutral-200/70 hover:text-neutral-700"
                  title="收起"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : view.kind === "run" ? (
            <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2.5">
              <button
                onClick={() => setView({ kind: "fleet" })}
                className="flex items-center rounded-md p-0.5 text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-800"
                title="返回 (Esc)"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {runSummary ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <StatusDot state={runSummary.state} active={runSummary.active} />
                  <span className="truncate font-mono text-xs text-neutral-600" title={runSummary.run_id}>
                    {runSummary.run_id.slice(0, 8)}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">{runSummary.mode}</span>
                  <span className="shrink-0 text-xs text-neutral-400">· {runSummary.state}</span>
                </div>
              ) : (
                <span className="text-xs text-neutral-400">run 已不在列表 (可能已结束并被清理)</span>
              )}
            </div>
          ) : (
            // subsession: 常驻只读横幅 (PRD R3 红线: 子会话属于子 agent 生命周期, 不接成可对话会话)
            <div className="border-b border-neutral-200">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  onClick={() => setView({ kind: "run", dir: view.dir })}
                  className="flex items-center rounded-md p-0.5 text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-800"
                  title="返回 (Esc)"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  <span className="truncate" title={view.title}>{view.title}</span>
                </span>
              </div>
              <div className="flex items-center gap-1.5 bg-[rgb(var(--surface-sunken)/var(--overlay-alpha))] px-3 py-1.5 text-[11px] text-neutral-500">
                <AlertCircle className="h-3 w-3 shrink-0" />
                子 agent 会话 · 只读视图
              </div>
            </div>
          )}

          {/* 内容区 */}
          <div className="flex-1 overflow-y-auto">
            {view.kind === "fleet" ? (
              <FleetList
                runs={runs}
                activeRuns={activeRuns}
                historyRuns={historyRuns}
                lastError={lastError}
                now={now}
                onOpenRun={(dir) => setView({ kind: "run", dir })}
              />
            ) : view.kind === "run" ? (
              <RunDetail
                summary={runSummary}
                detail={detail}
                detailLoading={detailLoading}
                detailError={detailError}
                detailMatches={detailDir === view.dir}
                now={now}
                onOpenSubsession={(sessionFile, title) =>
                  setView({ kind: "subsession", dir: view.dir, sessionFile, title })
                }
              />
            ) : (
              <SubSessionView sessionFile={view.sessionFile} />
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

// --- fleet 态: 活动区 + 历史区 + 空态 ---

function FleetList({
  runs, activeRuns, historyRuns, lastError, now, onOpenRun,
}: {
  runs: FleetRunSummary[];
  activeRuns: FleetRunSummary[];
  historyRuns: FleetRunSummary[];
  lastError: string | null;
  now: number;
  onOpenRun: (dir: string) => void;
}) {
  // 空态: 0 run 且无错误 → Radar 图标 + 文案 (PRD: 不显示骨架屏)
  if (runs.length === 0 && !lastError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <Radar className="h-8 w-8 text-neutral-300" />
        <p className="text-sm text-neutral-400">舰队停泊中</p>
        <p className="text-xs text-neutral-400">没有发现 subagent 运行产物</p>
      </div>
    );
  }
  return (
    <div>
      {lastError && (
        <div className="flex items-center gap-1.5 border-b border-neutral-200 px-4 py-2 text-[11px] text-neutral-400">
          <AlertCircle className="h-3 w-3 shrink-0" />
          产物目录不可达 · 已降级为空
        </div>
      )}
      {activeRuns.length > 0 && (
        <div className="py-1">
          <div className="px-4 py-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            活动中 ({activeRuns.length})
          </div>
          {activeRuns.map((r) => (
            <RunCard key={r.dir} run={r} now={now} active onOpen={onOpenRun} />
          ))}
        </div>
      )}
      {historyRuns.length > 0 && (
        <div className="py-1">
          <div className="px-4 py-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            历史 ({historyRuns.length}{runs.length - activeRuns.length > 10 ? ` / ${runs.length - activeRuns.length}` : ""})
          </div>
          {historyRuns.map((r) => (
            <RunRow key={r.dir} run={r} onOpen={onOpenRun} />
          ))}
        </div>
      )}
    </div>
  );
}

// 活动区卡片: 状态灯 + agent/model + 实时耗时 + 当前步骤 + token/cost 徽章 + recentOutput 末行预览
function RunCard({
  run, now, active, onOpen,
}: {
  run: FleetRunSummary;
  now: number;
  active: boolean;
  onOpen: (dir: string) => void;
}) {
  // 实时耗时: 未结束则 now - started, 已结束用 duration_ms
  const liveDur = active ? Math.max(0, now - run.started_at) : run.duration_ms;
  const currentStep = run.steps[run.current_step] ?? run.steps[run.steps.length - 1] ?? null;
  const lastOutput = currentStep?.recent_output?.[currentStep.recent_output.length - 1];
  return (
    <button
      onClick={() => onOpen(run.dir)}
      className="group mx-2 mb-1 flex w-[calc(100%-1rem)] flex-col gap-1.5 rounded-lg border border-[rgb(var(--border-subtle))] bg-[rgb(var(--surface-sunken)/var(--overlay-alpha))] px-3 py-2 text-left transition hover:-translate-y-px hover:border-[rgb(var(--border-strong))]"
    >
      <div className="flex items-center gap-2">
        <StatusDot state={run.state} active={run.active} />
        <span className="flex min-w-0 flex-1 items-center gap-1 text-xs font-medium text-neutral-800">
          <Bot className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <span className="truncate">{currentStep?.agent || run.run_id.slice(0, 8)}</span>
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-500">{fmtDuration(liveDur)}</span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-neutral-400">
        {currentStep?.model && (
          <span className="flex items-center gap-0.5 truncate">
            <Cpu className="h-3 w-3 shrink-0" />
            <span className="truncate">{currentStep.model.split("/").pop()}</span>
          </span>
        )}
        {run.current_step > 0 && (
          <span className="flex items-center gap-0.5">
            <ListChecks className="h-3 w-3 shrink-0" />
            step {run.current_step + 1}
          </span>
        )}
        {run.total_tokens > 0 && (
          <span className="flex items-center gap-0.5">
            <Clock className="h-3 w-3 shrink-0" />
            <span className="tabular-nums">{fmtTokens(run.total_tokens)}</span>
          </span>
        )}
        {run.total_cost_usd > 0 && (
          <span className="flex items-center gap-0.5">
            <Coins className="h-3 w-3 shrink-0" />
            <span className="tabular-nums">{fmtCost(run.total_cost_usd)}</span>
          </span>
        )}
      </div>
      {lastOutput && (
        <div className="truncate font-mono text-[11px] text-neutral-400" title={lastOutput}>
          {lastOutput}
        </div>
      )}
      {run.error && (
        <div className="truncate text-[11px] text-red-500" title={run.error}>
          {run.error}
        </div>
      )}
    </button>
  );
}

// 历史区紧凑行: 状态灯 + runId + state + 耗时 + 末步 agent
function RunRow({ run, onOpen }: { run: FleetRunSummary; onOpen: (dir: string) => void }) {
  const lastStep = run.steps[run.steps.length - 1] ?? null;
  return (
    <button
      onClick={() => onOpen(run.dir)}
      className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs transition hover:bg-neutral-200/60"
    >
      <StatusDot state={run.state} active={false} />
      <span className="shrink-0 font-mono text-neutral-500" title={run.run_id}>
        {run.run_id.slice(0, 8)}
      </span>
      {lastStep?.agent && (
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-neutral-600">
          <Bot className="h-3 w-3 shrink-0 text-neutral-400" />
          <span className="truncate">{lastStep.agent}</span>
        </span>
      )}
      <span className="shrink-0 font-mono tabular-nums text-neutral-400">{fmtDuration(run.duration_ms)}</span>
    </button>
  );
}

// --- run 态: steps 全列表 + events 时间线 + 汇总 ---

function RunDetail({
  summary, detail, detailLoading, detailError, detailMatches, now, onOpenSubsession,
}: {
  summary: FleetRunSummary | null;
  detail: { status: Record<string, unknown>; events: Record<string, unknown>[] } | null;
  detailLoading: boolean;
  detailError: string | null;
  detailMatches: boolean;
  now: number;
  onOpenSubsession: (sessionFile: string, title: string) => void;
}) {
  if (!summary) {
    return <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="加载中…" />;
  }
  if (detailError) {
    return <p className="px-4 py-6 text-sm text-red-500">{detailError}</p>;
  }
  // events 尾部时间线 (从 detail 懒加载; detail 未就绪时不显示)
  const events = detailMatches ? detail?.events ?? [] : [];
  return (
    <div>
      {/* 汇总数据行 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 px-4 py-2 text-[11px] text-neutral-500">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          <span className="tabular-nums">{fmtDuration(summary.active ? Math.max(0, now - summary.started_at) : summary.duration_ms)}</span>
        </span>
        {summary.total_tokens > 0 && (
          <span className="flex items-center gap-1">
            <ListChecks className="h-3 w-3" />
            <span className="tabular-nums">{fmtTokens(summary.total_tokens)}</span>
          </span>
        )}
        {summary.total_cost_usd > 0 && (
          <span className="flex items-center gap-1">
            <Coins className="h-3 w-3" />
            <span className="tabular-nums">{fmtCost(summary.total_cost_usd)}</span>
          </span>
        )}
        <span className="tabular-nums">{summary.turn_count} 轮</span>
        <span className="tabular-nums">{summary.tool_count} 工具</span>
        <span className="truncate text-neutral-400" title={summary.cwd}>{summary.cwd}</span>
      </div>
      {summary.error && (
        <div className="flex items-start gap-1.5 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-pre-line">{summary.error}</span>
        </div>
      )}
      {/* steps 列表 */}
      {summary.steps.length === 0 ? (
        <Hint text="无步骤数据" />
      ) : (
        summary.steps.map((step, i) => (
          <StepCard
            key={i}
            index={i}
            step={step}
            runSessionFile={summary.session_file}
            active={summary.active && i === summary.current_step}
            onOpenSubsession={onOpenSubsession}
          />
        ))
      )}
      {/* events 时间线 (尾部, 等宽小字) */}
      {events.length > 0 && (
        <div className="border-t border-neutral-200 px-4 py-2">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            事件流 ({events.length})
          </div>
          <div className="space-y-0.5 font-mono text-[11px] text-neutral-500">
            {events.map((ev, i) => {
              const type = String(ev.type ?? "");
              const ts = ev.ts as number | undefined;
              return (
                <div key={i} className="flex gap-1.5">
                  <span className="shrink-0 tabular-nums text-neutral-400">{ts ? fmtTime(ts) : "—"}</span>
                  <span className="truncate" title={type}>{type}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {detailLoading && !detailMatches && (
        <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="加载事件流…" />
      )}
    </div>
  );
}

// 单 step 卡片: agent + status + model + tokens + duration + recentOutput 滚动区 + 下钻按钮
function StepCard({
  index, step, runSessionFile, active, onOpenSubsession,
}: {
  index: number;
  step: FleetStepSummary;
  runSessionFile: string;
  active: boolean;
  onOpenSubsession: (sessionFile: string, title: string) => void;
}) {
  const outRef = useRef<HTMLDivElement>(null);
  // recentOutput 变化时自动滚底 (流式追加场景)
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [step.recent_output]);
  // 下钻 sessionFile: 优先 step 自己的, 缺失用 run 顶层兜底
  const sessionFile = step.session_file || runSessionFile;
  const canDrill = !!sessionFile;
  return (
    <div className="border-b border-neutral-200 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">{index + 1}</span>
        <StatusDot state={step.status} active={active} />
        <span className="flex min-w-0 flex-1 items-center gap-1 text-xs font-medium text-neutral-800">
          <Bot className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <span className="truncate">{step.agent || "(未命名)"}</span>
        </span>
        <span className="shrink-0 text-xs text-neutral-400">{step.status}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-neutral-400">
        {step.model && (
          <span className="flex items-center gap-0.5">
            <Cpu className="h-3 w-3" />
            <span className="truncate">{step.model.split("/").pop()}</span>
          </span>
        )}
        <span className="flex items-center gap-0.5 tabular-nums">
          <Clock className="h-3 w-3" />
          {fmtDuration(step.duration_ms)}
        </span>
        {step.tokens > 0 && (
          <span className="flex items-center gap-0.5 tabular-nums">
            <ListChecks className="h-3 w-3" />
            {fmtTokens(step.tokens)}
          </span>
        )}
      </div>
      {step.error && (
        <div className="mt-1 text-[11px] text-red-500" title={step.error}>
          {step.error}
        </div>
      )}
      {step.recent_output.length > 0 && (
        <div
          ref={outRef}
          className="mt-1.5 max-h-32 overflow-y-auto rounded bg-[rgb(var(--code-bg)/var(--code-alpha))] p-2 font-mono text-[11px] leading-relaxed text-neutral-600"
        >
          {step.recent_output.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
          ))}
        </div>
      )}
      {canDrill && (
        <button
          onClick={() => onOpenSubsession(sessionFile!, `${step.agent || "subagent"} 子会话`)}
          className="mt-1.5 flex items-center gap-0.5 text-[11px] text-[rgb(var(--primary-600))] transition hover:text-[rgb(var(--primary-700))]"
          title="查看完整子会话 (只读)"
        >
          <FileText className="h-3 w-3" />
          子会话
          <ChevronRight className="h-3 w-3" />
        </button>
      )}
      {/* R2 嵌套不塌陷: step 再 fanout 时递归渲染 children, 左缘竖线引导层级缩进。
          children step 无 currentStep 指针, active 一律 false (活动态由 state 灯显示) */}
      {step.children.length > 0 && (
        <div className="mt-2 ml-3 space-y-1 border-l-2 border-[rgb(var(--border-subtle))] pl-3">
          {step.children.map((c, ci) => (
            <StepCard
              key={ci}
              index={ci}
              step={c}
              runSessionFile={runSessionFile}
              active={false}
              onOpenSubsession={onOpenSubsession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- subsession 态: 只读渲染子 agent 完整子会话 (复用会话渲染管线, 无输入框) ---

function SubSessionView({ sessionFile }: { sessionFile: string }) {
  const [entries, setEntries] = useState<ChatEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // sessionFile 变化 (切不同 step 的子会话) 重拉; cancelled 守卫防串台
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    invoke<unknown[]>("read_session_entries_public", { sessionPath: sessionFile })
      .then((raw) => {
        if (!cancelled) setEntries(mapHistoryEntries(raw));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => { cancelled = true; };
  }, [sessionFile]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <AlertCircle className="h-6 w-6 text-red-400" />
        <p className="text-sm text-red-500">{error}</p>
        <p className="text-xs text-neutral-400">子会话文件可能已被清理</p>
      </div>
    );
  }
  if (!entries) {
    return <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="读取子会话…" />;
  }
  if (entries.length === 0) {
    return <Hint text="子会话无消息" />;
  }
  return (
    <div className="px-4 py-3">
      <div className="space-y-3">
        {entries.map((e) =>
          e.kind === "message" ? (
            <MessageItem key={e.id} entry={e} />
          ) : e.kind === "notification" ? (
            <NotificationItem key={e.id} entry={e} />
          ) : (
            <ToolCallCard key={e.id} entry={e} />
          ),
        )}
      </div>
    </div>
  );
}

// 列表空态与加载提示
function Hint({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-neutral-400">
      {icon}
      {text}
    </div>
  );
}