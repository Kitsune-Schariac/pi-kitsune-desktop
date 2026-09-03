// Subagent 舰队侧栏面板: 会话区右侧内嵌面板, 三态视图机 fleet → run → subsession。
// 交互骨架对齐 GitSidebarPanel (右侧内嵌圆角卡片、左缘拖拽调宽、Esc 层级)。
// 数据源: store/fleet.ts 2s 轮询 status.json (面板开着才轮询), 详情/子会话懒加载。
// 视觉走皮肤 CSS token (surface/border/primary/red), 禁 backdrop-filter/emoji/硬编码色。
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Radar, Bot, Cpu, Clock, Coins, ListChecks, ChevronRight, ChevronLeft,
  X, RefreshCw, Loader2, AlertCircle, FileText, Database, MessageSquareText, ChevronDown,
  CheckCircle2, Wrench,
} from "lucide-react";
import { useFleetStore, toArtifactEntry, toStreamEntry, parseSessionUuid, type FleetEntry } from "../store/fleet";
import type { FleetRunSummary, FleetStepSummary } from "../store/fleet";
import { useSessionStore, mapHistoryEntries, type ChatEntry } from "../store/session";
import { useFleetStreamEntries } from "../hooks/useFleetStreamEntries";
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
      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--primary-500)] animate-pulse" />
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
  const scope = useFleetStore((s) => s.scope);
  const setScope = useFleetStore((s) => s.setScope);
  // 当前会话 sessionPath (get_state 返回的主会话 jsonl 路径) → 解析 uuid 做会话锚定 (design §3)
  const sessionPath = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.sessionPath : null;
  });
  // stream 条目: 当前会话 entries 纯派生 (hook + useMemo, 不进 store/不扫文件)
  const streamEntries = useFleetStreamEntries();

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
  // 会话锚定 uuid (当前会话主会话 jsonl 路径解析), 空串 = 无会话/未落盘 → 退化全部视图
  const currentUuid = useMemo(() => parseSessionUuid(sessionPath), [sessionPath]);
  // 双源合并 (design §3: 合并点在面板 useMemo, stream=hook 派生, artifact=store 状态)。
  // scope=current: stream 全保留 + 本会话 artifact; 非本会话 running artifact → otherActive 折叠行。
  // scope=all 或无会话 (currentUuid 空): artifact 全可见 + stream (跨会话 stream 不扫, 仅本会话)。
  // 排序: running 优先 (startedAt 降序), 其余 startedAt 降序
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
      // 非本会话的 running artifact 收进折叠桶 (不进主列表, 不接下钻)
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
          className="group absolute bottom-2 left-0 top-2 z-10 flex w-2 cursor-col-resize items-center justify-center"
          title="拖动调整宽度 · 双击复位"
        >
          <div
            className={`h-10 w-[3px] rounded-full transition duration-fast ease-out ${
              dragging ? "bg-[var(--primary-500)]" : "bg-transparent group-hover:bg-[var(--border-strong)]"
            }`}
          />
        </div>
        <aside className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-base)_calc(var(--chat-alpha)_*_100%),transparent)] shadow-sm">
          {/* header: 三态各异。fleet = 标题+刷新+收起; run = ‹返回+runId+state; subsession = ‹返回+只读横幅 */}
          {view.kind === "fleet" ? (
            <>
            <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
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
                  className="rounded-md p-1 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-700 disabled:opacity-40"
                  title="刷新"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                </button>
                <button
                  onClick={onClose}
                  className="rounded-md p-1 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-700"
                  title="收起"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {/* segmented control: 本会话 / 全部 (design §3 会话锚定), 仅 fleet 态显示 */}
            {/* 高亮用生效态: scope=current 但 sessionPath 未就绪时实际渲染全部,
                UI 必须反映生效态而非选择态 (review SF2); 点击仍写 scope, 就绪后自动回到用户选择 */}
            <div className="flex items-center gap-1 border-b border-neutral-200 px-3 py-2">
              <div className="flex rounded-md border border-[var(--border-subtle)] p-1">
                <button
                  onClick={() => setScope("current")}
                  className={`rounded-md px-3 py-1 text-xs transition duration-fast ease-out ${
                    scope === "current" && currentUuid !== ""
                      ? "bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] text-neutral-800"
                      : "text-neutral-500 hover:text-neutral-700"
                  }`
                }
                >
                  本会话
                </button>
                <button
                  onClick={() => setScope("all")}
                  className={`rounded-md px-3 py-1 text-xs transition duration-fast ease-out ${
                    scope === "all"
                      ? "bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] text-neutral-800"
                      : "text-neutral-500 hover:text-neutral-700"
                  }`
                }
                >
                  全部
                </button>
              </div>
            </div>
            </>
          ) : view.kind === "run" ? (
            <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2">
              <button
                onClick={() => setView({ kind: "fleet" })}
                className="flex items-center rounded-md p-1 text-neutral-500 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-800"
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
                  className="flex items-center rounded-md p-1 text-neutral-500 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-800"
                  title="返回 (Esc)"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                  <FileText className="h-4 w-4 shrink-0 text-neutral-400" />
                  <span className="truncate" title={view.title}>{view.title}</span>
                </span>
              </div>
              <div className="flex items-center gap-2 bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] px-3 py-2 text-xs text-neutral-500">
                <AlertCircle className="h-3 w-3 shrink-0" />
                子 agent 会话 · 只读视图
              </div>
            </div>
          )}

          {/* 内容区 */}
          <div className="flex-1 overflow-y-auto">
            {view.kind === "fleet" ? (
              <FleetList
                entries={merged.entries}
                otherActive={merged.otherActive}
                scope={scope}
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

// --- fleet 态: 双源合并列表 (artifact + stream) + 活动区/历史区 + 会话锚定折叠 ---

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
  // 空态: 0 条目且无错误。scope 分文案 (design R7): 本会话空 → 还没记录; 全部空 → 停泊中
  if (entries.length === 0 && otherActive.length === 0 && !lastError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <Radar className="h-8 w-8 text-neutral-300" />
        <p className="text-sm text-neutral-400">
          {scope === "current" ? "本会话还没有 subagent 记录" : "舰队停泊中"}
        </p>
        <p className="text-xs text-neutral-400">
          {scope === "current" ? "派发子代理后会在这里显示" : "没有发现 subagent 运行产物"}
        </p>
      </div>
    );
  }
  const active = entries.filter((e) => e.state === "running");
  const history = entries.filter((e) => e.state !== "running").slice(0, 10);
  const historyTotal = entries.length - active.length;
  return (
    <div>
      {lastError && (
        <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2 text-xs text-neutral-400">
          <AlertCircle className="h-3 w-3 shrink-0" />
          产物目录不可达 · 已降级为空
        </div>
      )}
      {active.length > 0 && (
        <div className="py-1">
          <div className="px-4 py-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
            活动中 ({active.length})
          </div>
          {active.map((e) => (
            <FleetEntryCard key={e.key} entry={e} now={now} onOpenRun={onOpenRun} />
          ))}
        </div>
      )}
      {history.length > 0 && (
        <div className="py-1">
          <div className="px-4 py-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
            历史 ({history.length}{historyTotal > 10 ? ` / ${historyTotal}` : ""})
          </div>
          {history.map((e) => (
            <FleetEntryRow key={e.key} entry={e} onOpenRun={onOpenRun} />
          ))}
        </div>
      )}
      {otherActive.length > 0 && <OtherActiveFold entries={otherActive} now={now} />}
    </div>
  );
}

// 活动态卡片: 分流 artifact (复用 v1 RunCard) / stream (新 StreamCard)
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

// 历史态紧凑行: 分流 artifact (复用 v1 RunRow) / stream (新 StreamRow)
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

// stream 共享展开抽屉: prompt 全文 + result 全文 (原地展开, max-height 过渡, 不弹层)
function StreamDrawer({ entry, expanded }: { entry: FleetEntry; expanded: boolean }) {
  const call = entry.call;
  if (!call) return null;
  return (
    <div className={`overflow-hidden transition-[max-height] duration-200 ${expanded ? "max-h-[600px]" : "max-h-0"}`}>
      <div className="mt-1 space-y-2 border-t border-[var(--border-subtle)] pt-2">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Prompt</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-[color-mix(in_oklch,var(--code-bg)_calc(var(--code-alpha)_*_100%),transparent)] p-2 font-mono text-xs leading-relaxed text-neutral-600">
            {call.fullPrompt || "—"}
          </pre>
        </div>
        {call.fullResult && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">结果</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-[color-mix(in_oklch,var(--code-bg)_calc(var(--code-alpha)_*_100%),transparent)] p-2 font-mono text-xs leading-relaxed text-neutral-600">
              {call.fullResult}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// stream 活动态卡片: 来源徽章 (MessageSquareText) + 呼吸灯 + 耗时 + prompt 摘要 + 展开抽屉
function StreamCard({ entry }: { entry: FleetEntry }) {
  const [expanded, setExpanded] = useState(false);
  const call = entry.call!;
  return (
    <div className="mx-2 mb-1 flex w-[calc(100%-1rem)] flex-col gap-1 rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] px-3 py-2 transition duration-fast ease-out hover:border-[var(--border-strong)]">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-left">
        <StatusDot state={entry.state} active={entry.state === "running"} />
        <span title="对话派发" className="shrink-0"><MessageSquareText className="h-4 w-4 text-neutral-400" /></span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-800">{call.agent}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-500">
          {entry.durationMs != null ? fmtDuration(entry.durationMs) : "—"}
        </span>
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
        )}
      </button>
      <div className="truncate text-xs text-neutral-500" title={call.prompt}>
        {call.prompt || (entry.state === "running" ? "运行中…" : "—")}
      </div>
      <StreamDrawer entry={entry} expanded={expanded} />
    </div>
  );
}

// stream 历史态紧凑行: 徽章 + 状态灯 + agent + 耗时 + 展开抽屉 (chevron 旋转)
function StreamRow({ entry }: { entry: FleetEntry }) {
  const [expanded, setExpanded] = useState(false);
  const call = entry.call!;
  return (
    <div className="flex flex-col">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs transition duration-fast ease-out hover:bg-neutral-200/60"
      >
        <StatusDot state={entry.state} active={false} />
        <span title="对话派发" className="shrink-0"><MessageSquareText className="h-3 w-3 text-neutral-400" /></span>
        <span className="min-w-0 flex-1 truncate text-neutral-600">{call.agent}</span>
        <span className="shrink-0 font-mono tabular-nums text-neutral-400">
          {entry.durationMs != null ? fmtDuration(entry.durationMs) : "—"}
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-400" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-neutral-400" />
        )}
      </button>
      <StreamDrawer entry={entry} expanded={expanded} />
    </div>
  );
}

// 其他会话活动折叠行: 本会话视图下非本会话 running artifact 折叠为摘要 (design R5)
// N=0 不渲染; 展开为紧凑列表 (只读, 不接下钻 → 切「全部」查看详情)
function OtherActiveFold({ entries, now }: { entries: FleetEntry[]; now: number }) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null; // 调用方已保证, 二次防御
  return (
    <div className="py-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-neutral-500 transition duration-fast ease-out hover:bg-neutral-200/60"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform duration-base ease-swift ${expanded ? "rotate-90" : ""}`} />
        <span>其他会话 {entries.length} 个活动中</span>
      </button>
      {expanded && (
        <div className="pb-1">
          {entries.map((e) => (
            <div key={e.key} className="flex items-center gap-2 px-6 py-1 text-xs">
              <StatusDot state={e.state} active />
              <span title="后台产物" className="shrink-0"><Database className="h-3 w-3 text-neutral-400" /></span>
              <span className="min-w-0 flex-1 truncate text-neutral-600">{e.agent}</span>
              <span className="shrink-0 font-mono tabular-nums text-neutral-400">
                {e.run ? fmtDuration(e.run.active ? Math.max(0, now - e.run.started_at) : e.run.duration_ms) : "—"}
              </span>
              <span className="shrink-0 truncate text-neutral-400" title={e.run?.cwd}>
                {e.run?.cwd.split(/[\\/]/).pop()}
              </span>
            </div>
          ))}
          <div className="px-6 py-1 text-xs text-neutral-400">切到「全部」视图查看详情</div>
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
  const activeTools = currentStep?.active_tools ?? [];
  return (
    <button
      onClick={() => onOpen(run.dir)}
      className="group mx-2 mb-1 flex w-[calc(100%-1rem)] flex-col gap-2 rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] px-3 py-2 text-left transition duration-base ease-swift hover:-translate-y-px hover:border-[var(--border-strong)]"
    >
      <div className="flex items-center gap-2">
        <StatusDot state={run.state} active={run.active} />
        <span className="flex min-w-0 flex-1 items-center gap-1 text-xs font-medium text-neutral-800">
          <span title="后台产物" className="shrink-0"><Database className="h-4 w-4 text-neutral-400" /></span>
          <span className="truncate">{currentStep?.agent || run.run_id.slice(0, 8)}</span>
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-500">{fmtDuration(liveDur)}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-neutral-400">
        {currentStep?.model && (
          <span className="flex items-center gap-1 truncate">
            <Cpu className="h-3 w-3 shrink-0" />
            <span className="truncate">{currentStep.model.split("/").pop()}</span>
          </span>
        )}
        {run.current_step > 0 && (
          <span className="flex items-center gap-1">
            <ListChecks className="h-3 w-3 shrink-0" />
            step {run.current_step + 1}
          </span>
        )}
        {run.total_tokens > 0 && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3 shrink-0" />
            <span className="tabular-nums">{fmtTokens(run.total_tokens)}</span>
          </span>
        )}
        {run.total_cost_usd > 0 && (
          <span className="flex items-center gap-1">
            <Coins className="h-3 w-3 shrink-0" />
            <span className="tabular-nums">{fmtCost(run.total_cost_usd)}</span>
          </span>
        )}
      </div>
      {/* 当前工具行 (活动态专属): 正在执行的工具调用。多工具并列 ≤3, 超出折叠 +N;
          done 用弱化色 + 对勾图标区分「刚完成」; 空 (思考/输出中) 整行不渲染 */}
      {active && activeTools.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {activeTools.slice(0, 3).map((t, i) => (
            <span
              key={i}
              className={`flex max-w-full items-center gap-1 rounded-sm px-2 py-1 text-xs ${
                t.done
                  ? "bg-[color-mix(in_oklch,var(--border-subtle)_50%,transparent)] text-neutral-400"
                  : "bg-[color-mix(in_oklch,var(--primary-500)_12%,transparent)] text-[var(--primary-600)]"
              }`}
              title={`${t.name} ${t.summary}`}
            >
              {t.done ? (
                <CheckCircle2 className="h-3 w-3 shrink-0" />
              ) : (
                <Wrench className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">{t.name}</span>
              {t.summary && (
                <span className={`truncate font-mono ${t.done ? "text-neutral-400/80" : "text-[var(--primary-700)]"}`}>
                  {t.summary}
                </span>
              )}
            </span>
          ))}
          {activeTools.length > 3 && (
            <span className="rounded-sm px-2 py-1 text-xs text-neutral-400">
              +{activeTools.length - 3}
            </span>
          )}
        </div>
      )}
      {lastOutput && (
        <div className="truncate font-mono text-xs text-neutral-400" title={lastOutput}>
          {lastOutput}
        </div>
      )}
      {run.error && (
        <div className="truncate text-xs text-red-500" title={run.error}>
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
      className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs transition duration-fast ease-out hover:bg-neutral-200/60"
    >
      <StatusDot state={run.state} active={false} />
      <span className="shrink-0 font-mono text-neutral-500" title={run.run_id}>
        {run.run_id.slice(0, 8)}
      </span>
      {lastStep?.agent && (
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-neutral-600">
          <span title="后台产物" className="shrink-0"><Database className="h-3 w-3 text-neutral-400" /></span>
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 px-4 py-2 text-xs text-neutral-500">
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
        <div className="flex items-start gap-2 border-b border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] px-4 py-2 text-xs text-red-500">
          <AlertCircle className="mt-1 h-4 w-4 shrink-0" />
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
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
            事件流 ({events.length})
          </div>
          <div className="space-y-1 font-mono text-xs text-neutral-500">
            {events.map((ev, i) => {
              const type = String(ev.type ?? "");
              const ts = ev.ts as number | undefined;
              return (
                <div key={i} className="flex gap-2">
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
    <div className="border-b border-neutral-200 px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums text-neutral-400">{index + 1}</span>
        <StatusDot state={step.status} active={active} />
        <span className="flex min-w-0 flex-1 items-center gap-1 text-xs font-medium text-neutral-800">
          <Bot className="h-4 w-4 shrink-0 text-neutral-400" />
          <span className="truncate">{step.agent || "(未命名)"}</span>
        </span>
        <span className="shrink-0 text-xs text-neutral-400">{step.status}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
        {step.model && (
          <span className="flex items-center gap-1">
            <Cpu className="h-3 w-3" />
            <span className="truncate">{step.model.split("/").pop()}</span>
          </span>
        )}
        <span className="flex items-center gap-1 tabular-nums">
          <Clock className="h-3 w-3" />
          {fmtDuration(step.duration_ms)}
        </span>
        {step.tokens > 0 && (
          <span className="flex items-center gap-1 tabular-nums">
            <ListChecks className="h-3 w-3" />
            {fmtTokens(step.tokens)}
          </span>
        )}
      </div>
      {step.error && (
        <div className="mt-1 text-xs text-red-500" title={step.error}>
          {step.error}
        </div>
      )}
      {step.recent_output.length > 0 && (
        <div
          ref={outRef}
          className="mt-2 max-h-32 overflow-y-auto rounded-sm bg-[color-mix(in_oklch,var(--code-bg)_calc(var(--code-alpha)_*_100%),transparent)] p-2 font-mono text-xs leading-relaxed text-neutral-600"
        >
          {step.recent_output.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
          ))}
        </div>
      )}
      {canDrill && (
        <button
          onClick={() => onOpenSubsession(sessionFile!, `${step.agent || "subagent"} 子会话`)}
          className="mt-2 flex items-center gap-1 text-xs text-[var(--primary-600)] transition duration-fast ease-out hover:text-[var(--primary-700)]"
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
        <div className="mt-2 ml-3 space-y-1 border-l-2 border-[var(--border-subtle)] pl-3">
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
