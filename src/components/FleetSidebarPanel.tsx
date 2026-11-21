// Subagent 代理侧栏面板: 三态视图机 list → run → subsession。
// 双源融合: artifact (2s/8s 变频轮询后台产物) + stream (当前会话前台派发)。
// 全面对齐项目视觉令牌与原语: ui/Segmented · ui/EmptyHint · .live-dot · .tel-card。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot, Cpu, Clock, Coins, ListChecks, ChevronRight, ChevronLeft,
  X, RefreshCw, Loader2, AlertCircle, FileText, Database, MessageSquareText,
  ChevronDown, CheckCircle2, Wrench,
} from "lucide-react";
import {
  useFleetStore, toArtifactEntry, toStreamEntry, parseSessionUuid,
  type FleetEntry, type FleetRunSummary, type FleetStepSummary,
} from "../store/fleet";
import { useSessionStore, mapHistoryEntries, type ChatEntry } from "../store/session";
import { useFleetStreamEntries } from "../hooks/useFleetStreamEntries";
import { buildTimeline } from "../lib/timeline";
import { TurnView } from "./timeline/TurnView";
import { StepDetail } from "./inspector/StepDetail";
import { EmptyHint, Segmented } from "./ui";

type View =
  | { kind: "fleet" }
  | { kind: "run"; dir: string }
  | { kind: "subsession"; dir: string; sessionFile: string; title: string };

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

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

// 状态灯: 运行中统一复用全局唯一动效 .live-dot; 失败 = err; 完成 = ok; 未知 = line-2
function StatusDot({ state, active }: { state: string; active: boolean }) {
  if (active) {
    return <span className="live-dot" />;
  }
  const t = (state || "").toLowerCase();
  if (["failed", "error", "aborted"].includes(t)) {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-err" />;
  }
  if (["complete", "completed", "success", "succeeded", "done"].includes(t)) {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-ok" />;
  }
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-line-2" />;
}

interface Props {
  onClose?: () => void;
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
  const scope = useFleetStore((s) => s.scope);
  const setScope = useFleetStore((s) => s.setScope);
  const pendingRunDir = useFleetStore((s) => s.pendingRunDir);
  const consumePendingRunDir = useFleetStore((s) => s.consumePendingRunDir);

  const sessionPath = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.sessionPath : null;
  });
  const streamEntries = useFleetStreamEntries();

  const [view, setView] = useState<View>({ kind: "fleet" });
  const [now, setNow] = useState(Date.now());

  // 消费来自「概览 · 后台任务」或「步骤详情」的直达定位请求
  useEffect(() => {
    if (!pendingRunDir) return;
    const dir = consumePendingRunDir();
    if (dir) {
      setView({ kind: "run", dir });
    }
  }, [pendingRunDir, consumePendingRunDir]);

  useEffect(() => {
    startPolling();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopPolling();
      clearInterval(tick);
    };
  }, [startPolling, stopPolling]);

  useEffect(() => {
    if (view.kind === "run") {
      void openRunDetail(view.dir);
    } else {
      closeRunDetail();
    }
  }, [view, openRunDetail, closeRunDetail]);

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

  const runSummary = useMemo<FleetRunSummary | null>(
    () => (view.kind === "run" ? runs.find((r) => r.dir === view.dir) ?? null : null),
    [runs, view],
  );
  const currentUuid = useMemo(() => parseSessionUuid(sessionPath), [sessionPath]);

  const merged = useMemo(() => {
    const artifactEntries = runs.map((r) =>
      toArtifactEntry(r, currentUuid !== "" && r.session_id === currentUuid),
    );
    const streamMapped = streamEntries.map((s) => toStreamEntry(s, now));
    let visible: FleetEntry[];
    const otherActive: FleetEntry[] = [];
    if (scope === "current" && currentUuid !== "") {
      visible = [...streamMapped, ...artifactEntries].filter(
        (e) => e.source === "stream" || e.isCurrentSession,
      );
      for (const e of artifactEntries) {
        if (!e.isCurrentSession && e.state === "running") otherActive.push(e);
      }
    } else {
      visible = [...streamMapped, ...artifactEntries];
    }
    visible.sort((a, b) => {
      if (a.state === "running" && b.state !== "running") return -1;
      if (b.state === "running" && a.state !== "running") return 1;
      return b.startedAt - a.startedAt;
    });
    otherActive.sort((a, b) => b.startedAt - a.startedAt);
    return { entries: visible, otherActive };
  }, [runs, streamEntries, scope, currentUuid, now]);

  // 顶部遥测汇总 (当前视角下活跃数 / 总 Token / 总花费)
  const totals = useMemo(() => {
    let activeCount = 0;
    let tokens = 0;
    let cost = 0;
    for (const e of merged.entries) {
      if (e.state === "running") activeCount += 1;
      if (e.run) {
        tokens += e.run.total_tokens;
        cost += e.run.total_cost_usd;
      }
    }
    return { activeCount, count: merged.entries.length, tokens, cost };
  }, [merged.entries]);

  const effectiveScope: "current" | "all" =
    scope === "current" && currentUuid !== "" ? "current" : "all";

  return (
    <>
      {view.kind === "fleet" ? (
        <div className="shrink-0 border-b border-line">
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <Segmented
              size="sm"
              value={effectiveScope}
              onChange={(v) => setScope(v)}
              ariaLabel="子代理范围"
              options={[
                { value: "current", label: "本会话" },
                { value: "all", label: "全部" },
              ]}
            />
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading}
                className="grid h-7 w-7 place-items-center rounded-md text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg disabled:opacity-40"
                title="刷新代理状态"
              >
                <RefreshCw className={`h-[14px] w-[14px] ${loading ? "animate-spin" : ""}`} />
              </button>
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="grid h-7 w-7 place-items-center rounded-md text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
                  title="收起"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* 顶部汇总遥测条 */}
          {totals.count > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-well/60 px-3 py-2 text-meta tabular-nums text-fg-3">
              <span className="flex items-center gap-1">
                {totals.activeCount > 0 && <span className="live-dot" />}
                <span>
                  <b className="font-mono font-medium text-fg">{totals.activeCount}</b> 活跃
                </span>
              </span>
              <span>
                共 <b className="font-mono font-medium text-fg-2">{totals.count}</b> 次
              </span>
              {totals.tokens > 0 && (
                <span className="font-mono text-fg-2">{fmtTokens(totals.tokens)} tok</span>
              )}
              {totals.cost > 0 && (
                <span className="ml-auto font-mono font-medium text-fg">
                  {fmtCost(totals.cost)}
                </span>
              )}
            </div>
          )}
        </div>
      ) : view.kind === "run" ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <button
            type="button"
            onClick={() => setView({ kind: "fleet" })}
            className="flex items-center rounded-md p-1 text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
            title="返回代理列表 (Esc)"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {runSummary ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <StatusDot state={runSummary.state} active={runSummary.active} />
              <span className="truncate font-mono text-label font-medium text-fg" title={runSummary.run_id}>
                {runSummary.run_id.slice(0, 8)}
              </span>
              <span className="shrink-0 rounded-sm bg-well px-1 text-meta text-fg-3">
                {runSummary.mode}
              </span>
              <span className="shrink-0 text-meta text-fg-4">· {runSummary.state}</span>
            </div>
          ) : (
            <span className="text-meta text-fg-3">任务已结束或产物已被清理</span>
          )}
        </div>
      ) : (
        <div className="shrink-0 border-b border-line">
          <div className="flex items-center gap-2 px-3 py-2">
            <button
              type="button"
              onClick={() => setView({ kind: "run", dir: view.dir })}
              className="flex items-center rounded-md p-1 text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
              title="返回任务详情 (Esc)"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="flex min-w-0 flex-1 items-center gap-2 text-label font-medium text-fg">
              <FileText className="h-[14px] w-[14px] shrink-0 text-fg-3" />
              <span className="truncate" title={view.title}>{view.title}</span>
            </span>
          </div>
          <div className="flex items-center gap-2 bg-well px-3 py-2 text-meta text-fg-2">
            <AlertCircle className="h-3 w-3 shrink-0" />
            子代理会话 · 只读视图
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view.kind === "fleet" ? (
          <FleetList
            entries={merged.entries}
            otherActive={merged.otherActive}
            scope={effectiveScope}
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
    </>
  );
}

export { FleetSidebarPanel as SubagentSidebarPanel };

function FleetList({
  entries, otherActive, scope, lastError, now, onOpenRun,
}: {
  entries: FleetEntry[];
  otherActive: FleetEntry[];
  scope: "current" | "all";
  lastError: string | null;
  now: number;
  onOpenRun: (dir: string) => void;
}) {
  if (entries.length === 0 && otherActive.length === 0 && !lastError) {
    return (
      <div className="p-4">
        <EmptyHint
          icon={<Bot className="h-5 w-5" />}
          title={scope === "current" ? "本会话暂无子代理记录" : "暂无子代理任务"}
        >
          {scope === "current" ? "主会话派发 Subagent 后会在此呈现进度与拓扑" : "未发现子代理运行产物"}
        </EmptyHint>
      </div>
    );
  }
  const active = entries.filter((e) => e.state === "running");
  const history = entries.filter((e) => e.state !== "running").slice(0, 15);
  const historyTotal = entries.length - active.length;

  return (
    <div className="space-y-3 p-3">
      {lastError && (
        <div className="flex items-center gap-2 rounded-md bg-well px-3 py-2 text-meta text-fg-3">
          <AlertCircle className="h-3 w-3 shrink-0" />
          产物目录不可达 · 已降级为空
        </div>
      )}

      {active.length > 0 && (
        <section className="space-y-2">
          <div className="px-1 text-meta font-semibold uppercase tracking-wide text-fg-4">
            运行中 ({active.length})
          </div>
          {active.map((e) => (
            <FleetEntryCard key={e.key} entry={e} now={now} onOpenRun={onOpenRun} />
          ))}
        </section>
      )}

      {history.length > 0 && (
        <section>
          <div className="mb-1 px-1 text-meta font-semibold uppercase tracking-wide text-fg-4">
            历史 ({history.length}{historyTotal > 15 ? ` / ${historyTotal}` : ""})
          </div>
          <div className="overflow-hidden rounded-md border border-edge bg-card">
            {history.map((e, idx) => (
              <div key={e.key} className={idx > 0 ? "border-t border-line" : ""}>
                <FleetEntryRow entry={e} onOpenRun={onOpenRun} />
              </div>
            ))}
          </div>
        </section>
      )}

      {otherActive.length > 0 && (
        <OtherActiveFold entries={otherActive} now={now} onOpenRun={onOpenRun} />
      )}
    </div>
  );
}

function FleetEntryCard({
  entry, now, onOpenRun,
}: {
  entry: FleetEntry;
  now: number;
  onOpenRun: (dir: string) => void;
}) {
  if (entry.source === "artifact" && entry.run) {
    return <RunCard run={entry.run} now={now} active onOpen={onOpenRun} />;
  }
  return <StreamCard entry={entry} />;
}

function FleetEntryRow({
  entry, onOpenRun,
}: {
  entry: FleetEntry;
  onOpenRun: (dir: string) => void;
}) {
  if (entry.source === "artifact" && entry.run) {
    return <RunRow run={entry.run} onOpen={onOpenRun} />;
  }
  return <StreamRow entry={entry} />;
}

function StreamDrawer({ entry, expanded }: { entry: FleetEntry; expanded: boolean }) {
  const call = entry.call;
  if (!call || !expanded) return null;
  return (
    <div className="mt-2 space-y-2 border-t border-line pt-2">
      <div>
        <div className="mb-1 text-meta font-medium uppercase tracking-wide text-fg-4">Prompt</div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-well p-2 font-mono text-meta leading-relaxed text-fg-2">
          {call.fullPrompt || "—"}
        </pre>
      </div>
      {call.fullResult && (
        <div>
          <div className="mb-1 text-meta font-medium uppercase tracking-wide text-fg-4">结果</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-well p-2 font-mono text-meta leading-relaxed text-fg-2">
            {call.fullResult}
          </pre>
        </div>
      )}
    </div>
  );
}

function StreamCard({ entry }: { entry: FleetEntry }) {
  const [expanded, setExpanded] = useState(false);
  const call = entry.call!;
  return (
    <div className="tel-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left"
      >
        <StatusDot state={entry.state} active={entry.state === "running"} />
        <span title="对话派发" className="shrink-0">
          <MessageSquareText className="h-[14px] w-[14px] text-fg-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-label font-medium text-fg">{call.agent}</span>
        <span className="shrink-0 font-mono text-meta tabular-nums text-fg-3">
          {entry.durationMs != null ? fmtDuration(entry.durationMs) : "—"}
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-fg-4" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-fg-4" />
        )}
      </button>
      <div className="mt-1 truncate text-meta text-fg-3" title={call.prompt}>
        {call.prompt || (entry.state === "running" ? "运行中…" : "—")}
      </div>
      <StreamDrawer entry={entry} expanded={expanded} />
    </div>
  );
}

function StreamRow({ entry }: { entry: FleetEntry }) {
  const [expanded, setExpanded] = useState(false);
  const call = entry.call!;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-meta transition-colors duration-fast ease-out hover:bg-hover"
      >
        <StatusDot state={entry.state} active={false} />
        <span title="对话派发" className="shrink-0">
          <MessageSquareText className="h-3 w-3 text-fg-4" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-fg-2">{call.agent}</span>
        <span className="shrink-0 font-mono tabular-nums text-fg-4">
          {entry.durationMs != null ? fmtDuration(entry.durationMs) : "—"}
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-fg-4" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-fg-4" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2">
          <StreamDrawer entry={entry} expanded />
        </div>
      )}
    </div>
  );
}

function OtherActiveFold({
  entries, now, onOpenRun,
}: {
  entries: FleetEntry[];
  now: number;
  onOpenRun: (dir: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-md border border-edge bg-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-meta text-fg-2 transition-colors duration-fast ease-out hover:bg-hover"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform duration-base ease-swift ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span className="live-dot" />
        <span>其他会话 {entries.length} 个代理运行中</span>
      </button>
      {expanded && (
        <div className="border-t border-line py-1">
          {entries.map((e) => (
            <button
              key={e.key}
              type="button"
              onClick={() => e.run && onOpenRun(e.run.dir)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left text-meta transition-colors duration-fast ease-out hover:bg-hover"
            >
              <Database className="h-3 w-3 shrink-0 text-fg-4" />
              <span className="min-w-0 flex-1 truncate text-fg-2">{e.agent}</span>
              <span className="shrink-0 font-mono tabular-nums text-fg-4">
                {e.run
                  ? fmtDuration(e.run.active ? Math.max(0, now - e.run.started_at) : e.run.duration_ms)
                  : "—"}
              </span>
              <span className="shrink-0 truncate text-fg-4" title={e.run?.cwd}>
                {e.run?.cwd.split(/[\\/]/).pop()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({
  run, now, active, onOpen,
}: {
  run: FleetRunSummary;
  now: number;
  active: boolean;
  onOpen: (dir: string) => void;
}) {
  const liveDur = active ? Math.max(0, now - run.started_at) : run.duration_ms;
  const currentStep = run.steps[run.current_step] ?? run.steps[run.steps.length - 1] ?? null;
  const lastOutput = currentStep?.recent_output?.[currentStep.recent_output.length - 1];
  const activeTools = currentStep?.active_tools ?? [];

  return (
    <button
      type="button"
      onClick={() => onOpen(run.dir)}
      className="tel-card flex w-full flex-col gap-2 text-left transition-colors duration-fast ease-out hover:border-line-2"
    >
      <div className="flex items-center gap-2">
        <StatusDot state={run.state} active={run.active} />
        <span className="flex min-w-0 flex-1 items-center gap-1 text-label font-medium text-fg">
          <span title="后台任务产物" className="shrink-0">
            <Database className="h-[13px] w-[13px] text-fg-3" />
          </span>
          <span className="truncate">{currentStep?.agent || run.run_id.slice(0, 8)}</span>
        </span>
        <span className="shrink-0 font-mono text-meta tabular-nums text-fg-3">
          {fmtDuration(liveDur)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-3">
        {currentStep?.model && (
          <span className="flex items-center gap-1 truncate">
            <Cpu className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{currentStep.model.split("/").pop()}</span>
          </span>
        )}
        {run.steps.length > 1 && (
          <span className="flex items-center gap-1 tabular-nums">
            <ListChecks className="h-3 w-3 shrink-0" />
            {run.current_step + 1}/{run.steps.length}
          </span>
        )}
        {run.total_tokens > 0 && (
          <span className="font-mono tabular-nums">{fmtTokens(run.total_tokens)} tok</span>
        )}
        {run.total_cost_usd > 0 && (
          <span className="flex items-center gap-1 font-mono tabular-nums">
            <Coins className="h-3 w-3 shrink-0" />
            {fmtCost(run.total_cost_usd)}
          </span>
        )}
      </div>

      {active && activeTools.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {activeTools.slice(0, 3).map((t, i) => (
            <span
              key={i}
              className={`flex max-w-full items-center gap-1 rounded-sm px-2 py-1 text-meta ${
                t.done ? "bg-well text-fg-4" : "bg-accent-soft text-fg"
              }`}
              title={`${t.name} ${t.summary}`}
            >
              {t.done ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-ok" />
              ) : (
                <Wrench className="h-3 w-3 shrink-0 text-fg-3" />
              )}
              <span className="truncate font-mono">{t.name}</span>
              {t.summary && (
                <span className="truncate font-mono text-fg-3">{t.summary}</span>
              )}
            </span>
          ))}
          {activeTools.length > 3 && (
            <span className="rounded-sm bg-well px-2 py-1 font-mono text-meta text-fg-4">
              +{activeTools.length - 3}
            </span>
          )}
        </div>
      )}

      {lastOutput && (
        <div className="truncate rounded-sm bg-well px-2 py-1 font-mono text-meta text-fg-3" title={lastOutput}>
          {lastOutput}
        </div>
      )}
      {run.error && (
        <div className="truncate text-meta text-err" title={run.error}>
          {run.error}
        </div>
      )}
    </button>
  );
}

function RunRow({ run, onOpen }: { run: FleetRunSummary; onOpen: (dir: string) => void }) {
  const lastStep = run.steps[run.steps.length - 1] ?? null;
  return (
    <button
      type="button"
      onClick={() => onOpen(run.dir)}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-meta transition-colors duration-fast ease-out hover:bg-hover"
    >
      <StatusDot state={run.state} active={false} />
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-fg-2">
        <span title="后台任务产物" className="shrink-0">
          <Database className="h-3 w-3 text-fg-4" />
        </span>
        <span className="truncate font-medium">
          {lastStep?.agent || run.run_id.slice(0, 8)}
        </span>
      </span>
      {run.total_cost_usd > 0 && (
        <span className="shrink-0 font-mono tabular-nums text-fg-4">
          {fmtCost(run.total_cost_usd)}
        </span>
      )}
      <span className="shrink-0 font-mono tabular-nums text-fg-3">
        {fmtDuration(run.duration_ms)}
      </span>
    </button>
  );
}

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
    return <Hint icon={<Loader2 className="h-4 w-4 animate-spin text-accent" />} text="加载任务详情…" />;
  }
  if (detailError) {
    return <p className="px-4 py-6 text-body text-err">{detailError}</p>;
  }
  const events = detailMatches ? detail?.events ?? [] : [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-well/60 px-3 py-2 text-meta text-fg-2">
        <span className="flex items-center gap-1 tabular-nums">
          <Clock className="h-3 w-3 text-fg-3" />
          {fmtDuration(summary.active ? Math.max(0, now - summary.started_at) : summary.duration_ms)}
        </span>
        {summary.total_tokens > 0 && (
          <span className="font-mono tabular-nums">{fmtTokens(summary.total_tokens)} tok</span>
        )}
        {summary.total_cost_usd > 0 && (
          <span className="flex items-center gap-1 font-mono tabular-nums">
            <Coins className="h-3 w-3 text-fg-3" />
            {fmtCost(summary.total_cost_usd)}
          </span>
        )}
        <span className="tabular-nums text-fg-3">{summary.turn_count} 轮</span>
        <span className="tabular-nums text-fg-3">{summary.tool_count} 工具</span>
        <span className="truncate font-mono text-fg-4" title={summary.cwd}>
          {summary.cwd.split(/[\\/]/).pop()}
        </span>
      </div>

      {summary.error && (
        <div className="flex items-start gap-2 border-b border-line bg-well px-3 py-2 text-meta text-err">
          <AlertCircle className="mt-[2px] h-[14px] w-[14px] shrink-0" />
          <span className="whitespace-pre-line">{summary.error}</span>
        </div>
      )}

      {summary.steps.length === 0 ? (
        <Hint text="暂无步骤数据" />
      ) : (
        <div className="space-y-2 p-3">
          {summary.steps.map((step, i) => (
            <StepCard
              key={i}
              index={i}
              step={step}
              runSessionFile={summary.session_file}
              active={summary.active && i === summary.current_step}
              onOpenSubsession={onOpenSubsession}
            />
          ))}
        </div>
      )}

      {events.length > 0 && (
        <div className="border-t border-line px-3 py-2">
          <div className="mb-1 text-meta font-semibold uppercase tracking-wide text-fg-4">
            事件流 ({events.length})
          </div>
          <div className="space-y-1 font-mono text-meta text-fg-3">
            {events.map((ev, i) => {
              const type = String(ev.type ?? "");
              const ts = ev.ts as number | undefined;
              return (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 tabular-nums text-fg-4">{ts ? fmtTime(ts) : "—"}</span>
                  <span className="truncate text-fg-2" title={type}>{type}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {detailLoading && !detailMatches && (
        <Hint icon={<Loader2 className="h-4 w-4 animate-spin text-accent" />} text="加载事件流…" />
      )}
    </div>
  );
}

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
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [step.recent_output]);

  const sessionFile = step.session_file || runSessionFile;
  const canDrill = !!sessionFile;

  return (
    <div className="tel-card">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-meta tabular-nums text-fg-4">#{index + 1}</span>
        <StatusDot state={step.status} active={active} />
        <span className="flex min-w-0 flex-1 items-center gap-1 text-label font-medium text-fg">
          <Bot className="h-[13px] w-[13px] shrink-0 text-fg-3" />
          <span className="truncate">{step.agent || "(未命名)"}</span>
        </span>
        <span className="shrink-0 text-meta text-fg-4">{step.status}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-3">
        {step.model && (
          <span className="flex items-center gap-1">
            <Cpu className="h-3 w-3" />
            <span className="truncate font-mono">{step.model.split("/").pop()}</span>
          </span>
        )}
        <span className="flex items-center gap-1 font-mono tabular-nums">
          <Clock className="h-3 w-3" />
          {fmtDuration(step.duration_ms)}
        </span>
        {step.tokens > 0 && (
          <span className="font-mono tabular-nums">{fmtTokens(step.tokens)} tok</span>
        )}
      </div>

      {step.error && (
        <div className="mt-1 text-meta text-err" title={step.error}>
          {step.error}
        </div>
      )}

      {step.recent_output.length > 0 && (
        <div
          ref={outRef}
          className="mt-2 max-h-32 overflow-y-auto rounded-sm bg-well p-2 font-mono text-meta leading-relaxed text-fg-2"
        >
          {step.recent_output.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
          ))}
        </div>
      )}

      {canDrill && (
        <button
          type="button"
          onClick={() => onOpenSubsession(sessionFile!, `${step.agent || "subagent"} 子会话`)}
          className="mt-2 inline-flex items-center gap-1 rounded-sm px-2 py-1 text-meta text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
          title="查看完整子会话 (只读)"
        >
          <FileText className="h-3 w-3" />
          查看只读子会话
          <ChevronRight className="h-3 w-3" />
        </button>
      )}

      {/* 递归渲染嵌套子代理编排树 */}
      {step.children.length > 0 && (
        <div className="mt-3 ml-2 space-y-2 border-l-2 border-line-2 pl-3">
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

function SubSessionView({ sessionFile }: { sessionFile: string }) {
  const [entries, setEntries] = useState<ChatEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openStepId, setOpenStepId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    setOpenStepId(null);
    invoke<unknown[]>("read_session_entries_public", { sessionPath: sessionFile })
      .then((raw) => {
        if (!cancelled) setEntries(mapHistoryEntries(raw));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => { cancelled = true; };
  }, [sessionFile]);

  const handleStepClick = useCallback((entry: ChatEntry) => {
    setOpenStepId((cur) => (cur === entry.id ? null : entry.id));
  }, []);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <AlertCircle className="h-6 w-6 text-err" />
        <p className="text-body text-err">{error}</p>
        <p className="text-meta text-fg-3">子会话文件可能已被清理</p>
      </div>
    );
  }
  if (!entries) {
    return <Hint icon={<Loader2 className="h-4 w-4 animate-spin text-accent" />} text="读取子会话…" />;
  }
  if (entries.length === 0) {
    return <Hint text="子会话无消息" />;
  }
  return (
    <div className="fs-session">
      <SubSessionTimeline
        entries={entries}
        openStepId={openStepId}
        onStepClick={handleStepClick}
        onCollapse={() => setOpenStepId(null)}
      />
    </div>
  );
}

function SubSessionTimeline({
  entries, openStepId, onStepClick, onCollapse,
}: {
  entries: ChatEntry[];
  openStepId: string | null;
  onStepClick: (entry: ChatEntry) => void;
  onCollapse: () => void;
}) {
  const turns = useMemo(() => buildTimeline(entries), [entries]);
  const openEntry = useMemo(
    () => (openStepId ? entries.find((e) => e.id === openStepId && e.kind === "tool") ?? null : null),
    [entries, openStepId],
  );
  return (
    <div className="chat-col compact">
      {turns.map((turn) => (
        <TurnView
          key={turn.id}
          turn={turn}
          live={false}
          streamingReplyId={null}
          selectedId={openStepId}
          revealSeq={0}
          onStepClick={onStepClick}
        />
      ))}
      {openEntry && (
        <div className="fs-detail">
          <StepDetail key={openEntry.id} entry={openEntry} onBack={onCollapse} hideLocate />
        </div>
      )}
    </div>
  );
}

function Hint({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-label text-fg-3">
      {icon}
      {text}
    </div>
  );
}
