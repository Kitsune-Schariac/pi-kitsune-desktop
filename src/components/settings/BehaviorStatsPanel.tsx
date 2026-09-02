import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle, ArrowLeft, Hourglass, Loader2,
  MessagesSquare, Repeat2, Archive, Timer, Wrench, ChevronRight,
  Brain, Bot,
} from "lucide-react";
import { StatsFilterBar, projectLabel } from "./StatsFilterBar";
import {
  resolveQueryBounds,
  useStatsFilterStore,
} from "../../store/statsFilter";

// ---- 后端 get_behavior_stats 返回结构 (字段与 Rust json! 键一一对应) ----
interface BehaviorSummary {
  turns: number; sessions: number;
  toolCalls: number; toolErrors: number;
  retries: number; errors: number; compactions: number;
  thinkingChars: number; textChars: number;
  thinkingRatio: number | null; // 无任何 thinking block → null (显示「无数据」, 非 0%)
  durationMs: number; avgTurnMs: number; maxTurnMs: number;
}

interface BehaviorStatsResult {
  summary: BehaviorSummary;
  byDay: {
    date: string; turns: number; toolCalls: number;
    retries: number; compactions: number;
    thinkingChars: number; textChars: number; durationMs: number;
  }[];
  toolDist: { name: string; count: number }[];
  slowTurns: {
    sessionId: string; fileName: string; path: string; project: string;
    turnIdx: number; durationMs: number; ts: string;
  }[];
  sessions: BehaviorSessionRow[];
  filters: { projects: string[] };
}

interface BehaviorSessionRow {
  sessionId: string; fileName: string; path: string; project: string;
  isSubagent: boolean; timestamp: string;
  turns: number; toolCalls: number; toolErrors: number;
  retries: number; errors: number; compactions: number;
  durationMs: number; maxTurnMs: number;
  thinkingRatio: number | null;
}

// ---- get_session_behavior 返回结构 (会话钻取) ----
interface SessionBehaviorResult {
  sessionId: string; fileName: string; project: string; isSubagent: boolean;
  summary: Omit<BehaviorSummary, "sessions" | "avgTurnMs">;
  toolDist: { name: string; count: number }[];
  turns: {
    idx: number; startTs: string; durationMs: number;
    toolCalls: number; toolErrors: number; retries: number; errors: number;
    thinkingChars: number; textChars: number;
    tools: [string, number][];
  }[];
}

// ---- 展示辅助 ----
const fmt = (n: number) => n.toLocaleString();

/** 耗时紧凑格式: 320ms / 3.2s / 5m11s / 1h07m */
function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
  return `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0")}m`;
}

/** 数字滚动: 值变化时 500ms rAF 插值 (汇总卡大数字的入场质感) */
function useCountUp(target: number, enabled: boolean) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    if (!enabled) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min((t - t0) / 500, 1);
      // easeOutCubic: 快起缓停, 数字滚动不拖沓
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled]);
  return display;
}

/** 轮耗时瀑布 (会话钻取的视觉重心): 每轮一条横条, 长度 = 相对最慢轮,
 *  颜色区分正常 / 含工具失败(amber) / 含重试错误(red); 自定义 tooltip 展示轮内明细 */
function TurnWaterfall({ turns }: { turns: SessionBehaviorResult["turns"] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // 下一帧再展开, 让初始 width:0 参与过渡
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const max = Math.max(...turns.map((t) => t.durationMs), 1);
  return (
    <div className="space-y-[3px]">
      {turns.map((t, i) => {
        const danger = t.errors > 0 || t.retries > 0;
        const warn = !danger && t.toolErrors > 0;
        const ratio = Math.max((t.durationMs / max) * 100, t.durationMs > 0 ? 1 : 0.4);
        const thinking = t.thinkingChars + t.textChars > 0
          ? Math.round((t.thinkingChars / (t.thinkingChars + t.textChars)) * 100)
          : null;
        return (
          <div key={t.idx} className="group relative flex items-center gap-2">
            <span className="w-8 shrink-0 text-right text-xs tabular-nums text-neutral-400">
              #{t.idx + 1}
            </span>
            <div className="h-[9px] flex-1 rounded-sm bg-neutral-100/80">
              <div
                className={`h-full rounded-sm transition-[width] duration-500 ease-out ${
                  danger
                    ? "bg-red-400/80 group-hover:bg-red-500"
                    : warn
                      ? "bg-amber-400/80 group-hover:bg-amber-500"
                      : "bg-primary-400/70 group-hover:bg-primary-500"
                }`}
                style={{
                  width: mounted ? `${ratio}%` : "0%",
                  // 展开序列错峰, 轮数多时任凭其后半段同时落位 (上限 ~800ms)
                  transitionDelay: mounted ? `${Math.min(i * 8, 800)}ms` : "0ms",
                }}
              />
            </div>
            <span className="w-14 shrink-0 text-xs tabular-nums text-neutral-500">
              {fmtDuration(t.durationMs)}
            </span>
            {/* 自定义 tooltip: 实底 bg-panel + 细边 (皮肤体系铁律: 禁 backdrop-filter) */}
            <div className="pointer-events-none absolute left-10 top-full z-20 mt-1 hidden w-52 rounded-md border border-neutral-200 bg-panel p-2 text-xs leading-relaxed text-neutral-600 shadow-lg group-hover:block">
              <div className="mb-1 font-medium text-neutral-800">
                第 {t.idx + 1} 轮 · {fmtDuration(t.durationMs)}
              </div>
              <div>工具调用 {t.toolCalls} 次{t.toolErrors > 0 ? ` (${t.toolErrors} 失败)` : ""}</div>
              {t.tools.length > 0 && (
                <div className="text-neutral-400">
                  {t.tools.map(([n, c]) => `${n}×${c}`).join(" · ")}
                </div>
              )}
              {thinking !== null && <div>thinking 占比 {thinking}%</div>}
              {t.retries > 0 && <div className="text-red-500">自动重试 {t.retries} 次</div>}
              {t.errors > 0 && <div className="text-red-500">错误 {t.errors} 次</div>}
              <div className="mt-1 text-neutral-400">
                {t.startTs ? new Date(t.startTs).toLocaleString("zh-CN") : "无时间戳"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** thinking 占比细环 (SVG stroke-dasharray); 无数据 = 灰环 + 文案 */
function ThinkingRing({ ratio }: { ratio: number | null }) {
  const R = 34;
  const C = 2 * Math.PI * R;
  const pct = ratio === null ? 0 : ratio;
  return (
    <div className="relative h-24 w-24">
      <svg viewBox="0 0 84 84" className="h-24 w-24 -rotate-90">
        <circle cx="42" cy="42" r={R} fill="none" strokeWidth="8" className="stroke-neutral-200/70" />
        <circle
          cx="42" cy="42" r={R} fill="none" strokeWidth="8" strokeLinecap="round"
          className="stroke-primary-500 transition-[stroke-dashoffset] duration-700 ease-out"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {ratio === null ? (
          <span className="text-xs text-neutral-400">无数据</span>
        ) : (
          <>
            <span className="text-lg font-semibold tabular-nums text-neutral-900">
              {Math.round(pct * 100)}%
            </span>
            <span className="text-xs text-neutral-400">thinking</span>
          </>
        )}
      </div>
    </div>
  );
}

/** 汇总卡: icon + label + count-up 大数字 (+ 可选脚注) */
function SummaryCard({
  icon: Icon, label, value, foot, animate, format = fmt,
}: {
  icon: typeof Wrench; label: string; value: number; foot?: string; animate: boolean;
  // 耗时类卡片传 fmtDuration: count-up 仍按毫秒插值, 只是落地展示换口径
  format?: (n: number) => string;
}) {
  const display = useCountUp(value, animate);
  return (
    <div className="rounded-md border border-neutral-200 bg-panel p-3 transition-shadow-sm duration-fast ease-out hover:shadow-md">
      <div className="mb-1 flex items-center gap-1 text-xs text-neutral-400">
        <Icon className="h-4 w-4 text-primary-500" />
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums text-neutral-900">{format(display)}</div>
      {foot && <div className="mt-1 text-xs text-neutral-400">{foot}</div>}
    </div>
  );
}

export function BehaviorStatsPanel() {
  // ---- 共享筛选 (与 Token 统计口径一致) ----
  const range = useStatsFilterStore((s) => s.range);
  const customStart = useStatsFilterStore((s) => s.customStart);
  const customEnd = useStatsFilterStore((s) => s.customEnd);
  const project = useStatsFilterStore((s) => s.project);

  // ---- 总览数据 ----
  const [data, setData] = useState<BehaviorStatsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 请求竞态保护: 快速切换筛选时只采纳最后一次响应
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const { startTime, endTime } = resolveQueryBounds({ range, customStart, customEnd });
    invoke<BehaviorStatsResult>("get_behavior_stats", {
      startTime, endTime, project: project || null,
    })
      .then((res) => { if (reqId.current === id) setData(res); })
      .catch((e) => { if (reqId.current === id) setError(String(e)); })
      .finally(() => { if (reqId.current === id) setLoading(false); });
  }, [range, customStart, customEnd, project]);

  // ---- 会话钻取 ----
  const [drillPath, setDrillPath] = useState<string | null>(null);
  const [drill, setDrill] = useState<SessionBehaviorResult | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);

  useEffect(() => {
    if (!drillPath) {
      setDrill(null);
      setDrillError(null);
      return;
    }
    let cancelled = false;
    setDrillLoading(true);
    setDrillError(null);
    invoke<SessionBehaviorResult>("get_session_behavior", { path: drillPath })
      .then((res) => { if (!cancelled) setDrill(res); })
      .catch((e) => { if (!cancelled) setDrillError(String(e)); })
      .finally(() => { if (!cancelled) setDrillLoading(false); });
    return () => { cancelled = true; };
  }, [drillPath]);

  // ==================== 会话钻取视图 ====================
  if (drillPath) {
    return (
      <div className="space-y-5 p-6">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDrillPath(null)}
            className="flex items-center gap-1 rounded-md border border-neutral-200 bg-panel px-2 py-2 text-xs text-neutral-600 transition duration-fast ease-out hover:bg-neutral-100"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </button>
          {drillLoading && <Loader2 className="h-4 w-4 animate-spin text-primary-500" />}
          {drill && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-neutral-500">
              {drill.isSubagent && (
                <span className="flex items-center gap-1 rounded-sm bg-neutral-100 px-2 py-1 text-xs text-neutral-500" title="嵌套 run 目录下的 subagent 会话">
                  <Bot className="h-3 w-3" />
                  subagent
                </span>
              )}
              <span className="font-mono text-neutral-400">{drill.sessionId.slice(0, 8)}</span>
              <span className="truncate" title={drill.project}>{projectLabel(drill.project)}</span>
            </div>
          )}
        </div>
        {drillError && (
          <p className="flex items-center gap-1 text-xs text-red-500">
            <AlertCircle className="h-4 w-4" /> {drillError}
          </p>
        )}
        {drill && (
          <>
            {/* 会话汇总 chips */}
            <div className="flex flex-wrap gap-2 text-xs">
              {[
                { icon: MessagesSquare, text: `${drill.summary.turns} 轮` },
                { icon: Wrench, text: `${drill.summary.toolCalls} 次工具` },
                { icon: Timer, text: `总耗时 ${fmtDuration(drill.summary.durationMs)}` },
                { icon: Hourglass, text: `最慢轮 ${fmtDuration(drill.summary.maxTurnMs)}` },
                { icon: Repeat2, text: `${drill.summary.retries} 次重试` },
                { icon: Archive, text: `${drill.summary.compactions} 次压缩` },
              ].map(({ icon: Icon, text }) => (
                <span
                  key={text}
                  className="flex items-center gap-2 rounded-full border border-neutral-200 bg-panel px-3 py-2 text-neutral-600"
                >
                  <Icon className="h-4 w-4 text-primary-500" />
                  {text}
                </span>
              ))}
            </div>

            {/* 轮耗时瀑布 */}
            <section className="rounded-md border border-neutral-200 bg-panel p-4">
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-sm font-medium text-neutral-700">轮耗时瀑布</h3>
                <div className="flex items-center gap-3 text-xs text-neutral-400">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-primary-400/70" />正常
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-amber-400/80" />工具失败
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-red-400/80" />错误/重试
                  </span>
                </div>
              </div>
              {drill.turns.length > 0 ? (
                <TurnWaterfall turns={drill.turns} />
              ) : (
                <p className="py-6 text-center text-xs text-neutral-400">该会话没有轮记录</p>
              )}
            </section>

            {/* 该会话工具分布 */}
            {drill.toolDist.length > 0 && (
              <ToolDistChart dist={drill.toolDist} title="工具分布 (本会话)" />
            )}
          </>
        )}
      </div>
    );
  }

  // ==================== 总览视图 ====================
  const summary = data?.summary;
  const byDay = data?.byDay ?? [];
  const toolDist = data?.toolDist ?? [];
  const slowTurns = data?.slowTurns ?? [];
  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-6 p-6">
      {/* 标题 + 加载指示 */}
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-neutral-900">对话行为统计</h2>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-primary-500" />}
        {error && (
          <span className="flex items-center gap-1 text-xs text-red-500">
            <AlertCircle className="h-4 w-4" /> {error}
          </span>
        )}
      </div>

      <StatsFilterBar projects={data?.filters.projects ?? []} />

      {/* 汇总卡片 */}
      {summary && (
        <div className="grid grid-cols-4 gap-2">
          <SummaryCard icon={MessagesSquare} label="轮数" value={summary.turns} animate={!loading}
            foot={`${summary.sessions} 个会话`} />
          <SummaryCard icon={Wrench} label="工具调用" value={summary.toolCalls} animate={!loading}
            foot={summary.toolErrors > 0 ? `${summary.toolErrors} 次失败` : undefined} />
          <SummaryCard icon={Timer} label="平均轮耗时" value={summary.avgTurnMs} animate={!loading}
            format={fmtDuration} foot={`最慢 ${fmtDuration(summary.maxTurnMs)}`} />
          <SummaryCard icon={Repeat2} label="自动重试" value={summary.retries} animate={!loading}
            foot={`错误 ${summary.errors} 次`} />
          <SummaryCard icon={Archive} label="压缩" value={summary.compactions} animate={!loading}
            foot={summary.compactions > 0 ? `每 ${Math.round(summary.turns / summary.compactions)} 轮一次` : undefined} />
          <SummaryCard icon={Hourglass} label="总耗时" value={summary.durationMs} animate={!loading}
            format={fmtDuration}
            foot={summary.sessions > 0 ? `${fmtDuration(Math.round(summary.durationMs / summary.sessions))} / 会话` : undefined} />
          {/* thinking 占比卡: 环图嵌卡, 跨两列 */}
          <div className="col-span-2 flex items-center gap-4 rounded-md border border-neutral-200 bg-panel p-3 transition-shadow-sm duration-fast ease-out hover:shadow-md">
            <ThinkingRing ratio={summary.thinkingRatio} />
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-1 text-xs text-neutral-400">
                <Brain className="h-4 w-4 text-primary-500" />
                thinking 占比
              </div>
              {summary.thinkingRatio === null ? (
                <div className="text-sm text-neutral-400">该范围会话均无 thinking 数据</div>
              ) : (
                <div className="text-xs leading-relaxed text-neutral-500">
                  thinking {fmt(summary.thinkingChars)} 字符
                  <br />
                  正文 {fmt(summary.textChars)} 字符
                  <span className="ml-1 text-neutral-400">(字符口径)</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 按天趋势: grouped 双系列 (轮数 / 工具调用) */}
      {byDay.length > 0 && (
        <section className="rounded-md border border-neutral-200 bg-panel p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-neutral-700">按天趋势</h3>
            <div className="flex items-center gap-3 text-xs text-neutral-400">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-primary-500" />轮数
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-primary-300/80" />工具调用
              </span>
              <span title="轮与工具调用量纲差一个数量级, 共用刻度会把轮数压成一条线">各自缩放</span>
              <span>{byDay[0].date} ~ {byDay[byDay.length - 1].date}</span>
            </div>
          </div>
          {(() => {
            // 两系列各按自身峰值归一: 工具调用峰值是轮数的近 10 倍, 共用刻度时
            // 轮数柱恒等于最小高度 = 趋势不可读; 绝对值走 hover title 不丢失
            const maxTurns = Math.max(...byDay.map((d) => d.turns), 1);
            const maxTools = Math.max(...byDay.map((d) => d.toolCalls), 1);
            return (
              <div className="flex h-28 items-end gap-[3px]">
                {byDay.map((d) => (
                  <div
                    key={d.date}
                    // h-full 不可省: 柱子用百分比高度, 需要日容器有确定高度做基准
                    // (父 items-end 下 flex item 不 stretch, 高度会退化成内容高 = 0)
                    className="flex h-full flex-1 items-end gap-[2px]"
                    title={`${d.date} · ${d.turns} 轮 · ${d.toolCalls} 次工具${d.retries > 0 ? ` · ${d.retries} 次重试` : ""}${d.compactions > 0 ? ` · ${d.compactions} 次压缩` : ""}`}
                  >
                    <div
                      className="flex-1 rounded-t-sm bg-primary-500/80 transition duration-fast ease-out hover:bg-primary-500"
                      style={{ height: `${Math.max((d.turns / maxTurns) * 100, d.turns > 0 ? 3 : 0)}%` }}
                    />
                    <div
                      className="flex-1 rounded-t-sm bg-primary-300/70 transition duration-fast ease-out hover:bg-primary-400"
                      style={{ height: `${Math.max((d.toolCalls / maxTools) * 100, d.toolCalls > 0 ? 3 : 0)}%` }}
                    />
                  </div>
                ))}
              </div>
            );
          })()}
        </section>
      )}

      {/* 工具分布 + 慢轮榜 并排 */}
      {(toolDist.length > 0 || slowTurns.length > 0) && (
        <div className="grid grid-cols-2 gap-4">
          {toolDist.length > 0 && <ToolDistChart dist={toolDist} title="工具分布" />}
          {slowTurns.length > 0 && (
            <section className="rounded-md border border-neutral-200 bg-panel p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-neutral-700">
                <Hourglass className="h-4 w-4 text-primary-500" />
                最慢轮次
              </h3>
              <div className="space-y-2">
                {slowTurns.slice(0, 6).map((s, i) => (
                  <button
                    key={`${s.path}-${s.turnIdx}`}
                    onClick={() => setDrillPath(s.path)}
                    className="group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition duration-fast ease-out hover:bg-neutral-50"
                    title={`钻取会话: ${s.fileName}`}
                  >
                    <span className={`w-5 shrink-0 text-center font-semibold tabular-nums ${
                      i === 0 ? "text-red-500" : i < 3 ? "text-amber-500" : "text-neutral-400"
                    }`}>
                      {i + 1}
                    </span>
                    <span className="w-16 shrink-0 font-medium tabular-nums text-neutral-800">
                      {fmtDuration(s.durationMs)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-neutral-500" title={s.project}>
                      {projectLabel(s.project)} · 第 {s.turnIdx + 1} 轮
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-neutral-300 transition duration-fast ease-out group-hover:text-primary-500" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* 会话明细 (点击行钻取) */}
      {sessions.length > 0 && (
        <section className="rounded-md border border-neutral-200 bg-panel">
          <h3 className="border-b border-neutral-100 px-4 py-3 text-sm font-medium text-neutral-700">
            会话明细 ({sessions.length})
          </h3>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-neutral-50 text-left text-neutral-400">
                <tr>
                  {["时间", "项目", "轮数", "工具", "耗时", "thinking", "重试", "压缩", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 text-neutral-600">
                {sessions.map((s) => (
                  <tr
                    key={s.path}
                    onClick={() => setDrillPath(s.path)}
                    className="cursor-pointer transition duration-fast ease-out hover:bg-neutral-50"
                    title={`钻取会话: ${s.fileName}`}
                  >
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-500">
                      {s.timestamp
                        ? new Date(s.timestamp).toLocaleString("zh-CN", {
                            month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                          })
                        : "--"}
                    </td>
                    <td className="max-w-[150px] truncate px-3 py-2">
                      <span className="flex items-center gap-1" title={s.project}>
                        {s.isSubagent && <Bot className="h-3 w-3 shrink-0 text-neutral-400" />}
                        <span className="truncate">{projectLabel(s.project)}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{s.turns}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {s.toolCalls}
                      {s.toolErrors > 0 && (
                        <span className="ml-1 text-amber-500" title={`${s.toolErrors} 次工具失败`}>
                          ({s.toolErrors} 败)
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmtDuration(s.durationMs)}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {s.thinkingRatio === null
                        ? <span className="text-neutral-400">无数据</span>
                        : `${Math.round(s.thinkingRatio * 100)}%`}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {s.retries > 0 ? <span className="text-red-500">{s.retries}</span> : 0}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{s.compactions}</td>
                    <td className="px-2 py-2">
                      <ChevronRight className="h-4 w-4 text-neutral-300" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 空态 */}
      {!loading && !error && summary && summary.turns === 0 && (
        <p className="rounded-md border border-dashed border-neutral-200 px-4 py-10 text-center text-sm text-neutral-400">
          该筛选范围内暂无行为数据
        </p>
      )}
    </div>
  );
}

/** 工具分布横向条形: top-8 逐条 + 其余归「其它」(未知工具名不丢弃) */
function ToolDistChart({ dist, title }: { dist: { name: string; count: number }[]; title: string }) {
  const top = dist.slice(0, 8);
  const rest = dist.slice(8);
  const restTotal = rest.reduce((s, d) => s + d.count, 0);
  const rows = restTotal > 0 ? [...top, { name: "其它", count: restTotal }] : top;
  const max = Math.max(...rows.map((d) => d.count), 1);
  const grand = dist.reduce((s, d) => s + d.count, 0);
  return (
    <section className="rounded-md border border-neutral-200 bg-panel p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-neutral-700">
        <Wrench className="h-4 w-4 text-primary-500" />
        {title}
      </h3>
      <div className="space-y-2">
        {rows.map((d) => (
          <div key={d.name} className="group flex items-center gap-2" title={rest.length > 0 && d.name === "其它" ? `含 ${rest.map((r) => `${r.name}×${r.count}`).join("、")}` : undefined}>
            <span className={`w-20 shrink-0 truncate text-right text-xs ${d.name === "其它" ? "text-neutral-400" : "text-neutral-600"}`}>
              {d.name}
            </span>
            <div className="h-4 flex-1 rounded-sm bg-neutral-100/80">
              <div
                className={`h-full rounded-sm transition-[width,background-color] duration-500 ease-out ${
                  d.name === "其它" ? "bg-neutral-300/70" : "bg-gradient-to-r from-primary-400/60 to-primary-500/80 group-hover:from-primary-400 group-hover:to-primary-500"
                }`}
                style={{ width: `${Math.max((d.count / max) * 100, 2)}%` }}
              />
            </div>
            <span className="w-16 shrink-0 text-xs tabular-nums text-neutral-500">
              {fmt(d.count)}
              <span className="ml-1 text-xs text-neutral-400">
                {Math.round((d.count / grand) * 100)}%
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
