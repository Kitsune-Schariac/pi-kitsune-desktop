import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownToLine, ArrowUpFromLine, Coins, Database, DatabaseZap,
  DollarSign, FolderKanban, Loader2, MessageSquare, AlertCircle,
} from "lucide-react";

// ---- 后端 get_token_stats 返回结构 ----
interface TokenStatsResult {
  summary: {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    total: number; cost: number; messageCount: number; sessionCount: number;
  };
  byDay: {
    date: string; input: number; output: number; cacheRead: number;
    cacheWrite: number; total: number; cost: number; messageCount: number;
  }[];
  sessions: {
    sessionId: string; fileName: string; project: string;
    provider: string; model: string; timestamp: string; messageCount: number;
    input: number; output: number; cacheRead: number; cacheWrite: number;
    total: number; cost: number;
  }[];
  filters: { projects: string[]; providers: string[]; models: string[] };
}

type TimeRange = "today" | "7d" | "30d" | "all";

// 快捷时间范围 → [start, end] 完整 ISO (start 含当天零点, end 取次日零点, 后端按字典序含两端比较)
function rangeBounds(range: TimeRange): { start: string | null; end: string | null } {
  if (range === "all") return { start: null, end: null };
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = new Date(today + 86_400_000).toISOString();
  const days = range === "today" ? 0 : range === "7d" ? 6 : 29;
  return { start: new Date(today - days * 86_400_000).toISOString(), end };
}

// 数值展示: token 用千分位, 花费保留 4 位小数
const fmt = (n: number) => n.toLocaleString();
const fmtCost = (n: number) => `$${n.toFixed(4)}`;

// 项目路径取 basename 展示 (全路径放 title), 空路径原样
function projectLabel(p: string) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

export function TokenStatsPanel() {
  // ---- 筛选条件 ----
  const [range, setRange] = useState<TimeRange>("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [project, setProject] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  // ---- 结果 ----
  const [data, setData] = useState<TokenStatsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 请求竞态保护: 快速切换筛选时只采纳最后一次响应
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const rb = rangeBounds(range);
    // 自定义起止覆盖快捷范围 (date 转 ISO; end 用当天 23:59:59.999 含当天)
    const startTime = customStart ? `${customStart}T00:00:00Z` : rb.start;
    const endTime = customEnd ? `${customEnd}T23:59:59.999Z` : rb.end;
    invoke<TokenStatsResult>("get_token_stats", {
      startTime, endTime,
      project: project || null,
      provider: provider || null,
      model: model || null,
    })
      .then((res) => { if (reqId.current === id) setData(res); })
      .catch((e) => { if (reqId.current === id) setError(String(e)); })
      .finally(() => { if (reqId.current === id) setLoading(false); });
  }, [range, customStart, customEnd, project, provider, model]);

  const summary = data?.summary;
  const byDay = data?.byDay ?? [];
  const sessions = data?.sessions ?? [];
  const filters = data?.filters;

  return (
    <div className="space-y-6 p-6">
      {/* 标题 + 加载指示 */}
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-neutral-900">Token 使用统计</h2>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-primary-500" />}
        {error && (
          <span className="flex items-center gap-1 text-xs text-red-500">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </span>
        )}
      </div>

      {/* 筛选栏 */}
      <div className="space-y-2.5 rounded-xl border border-neutral-200 bg-neutral-50/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* 时间快捷 */}
          <div className="flex overflow-hidden rounded-lg border border-neutral-200 bg-panel text-xs">
            {([["today", "今天"], ["7d", "近 7 天"], ["30d", "近 30 天"], ["all", "全部"]] as [TimeRange, string][]).map(([r, label]) => (
              <button
                key={r}
                onClick={() => { setRange(r); setCustomStart(""); setCustomEnd(""); }}
                className={`px-3 py-1.5 transition ${
                  range === r && !customStart && !customEnd
                    ? "bg-primary-500 font-medium text-white"
                    : "text-neutral-600 hover:bg-neutral-100"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* 自定义起止 */}
          <div className="flex items-center gap-1.5 text-xs text-neutral-500">
            <input
              type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
              className="rounded-lg border border-neutral-200 bg-panel px-2 py-1.5 text-neutral-700 outline-none focus:border-primary-400"
              title="自定义开始日期"
            />
            <span>至</span>
            <input
              type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
              className="rounded-lg border border-neutral-200 bg-panel px-2 py-1.5 text-neutral-700 outline-none focus:border-primary-400"
              title="自定义结束日期"
            />
          </div>
        </div>
        {/* 项目 / 供应商 / 模型 */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={project} onChange={(e) => setProject(e.target.value)}
            className="max-w-[220px] rounded-lg border border-neutral-200 bg-panel px-2 py-1.5 text-neutral-700 outline-none focus:border-primary-400"
            title="按项目筛选"
          >
            <option value="">全部项目</option>
            {(filters?.projects ?? []).map((p) => (
              <option key={p} value={p} title={p}>{projectLabel(p)}</option>
            ))}
          </select>
          <select
            value={provider} onChange={(e) => setProvider(e.target.value)}
            className="rounded-lg border border-neutral-200 bg-panel px-2 py-1.5 text-neutral-700 outline-none focus:border-primary-400"
            title="按供应商筛选"
          >
            <option value="">全部供应商</option>
            {(filters?.providers ?? []).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            value={model} onChange={(e) => setModel(e.target.value)}
            className="rounded-lg border border-neutral-200 bg-panel px-2 py-1.5 text-neutral-700 outline-none focus:border-primary-400"
            title="按模型筛选"
          >
            <option value="">全部模型</option>
            {(filters?.models ?? []).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>
      {/* 汇总卡片 */}
      {summary && (
        <div className="grid grid-cols-4 gap-2.5">
          {[
            { label: "输入", value: fmt(summary.input), icon: ArrowDownToLine },
            { label: "输出", value: fmt(summary.output), icon: ArrowUpFromLine },
            { label: "缓存读", value: fmt(summary.cacheRead), icon: Database },
            { label: "缓存写", value: fmt(summary.cacheWrite), icon: DatabaseZap },
            { label: "总计", value: fmt(summary.total), icon: Coins },
            { label: "花费", value: fmtCost(summary.cost), icon: DollarSign },
            { label: "消息数", value: fmt(summary.messageCount), icon: MessageSquare },
            { label: "会话数", value: fmt(summary.sessionCount), icon: FolderKanban },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-neutral-200 bg-panel p-3">
              <div className="mb-1 flex items-center gap-1 text-xs text-neutral-400">
                <Icon className="h-3.5 w-3.5 text-primary-500" />
                {label}
              </div>
              <div className="text-lg font-semibold tabular-nums text-neutral-900">{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* 按天趋势 (纯 CSS bar, 高度按当日总量归一化) */}
      {byDay.length > 0 && (
        <section className="rounded-xl border border-neutral-200 bg-panel p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-neutral-700">按天趋势</h3>
            <span className="text-xs text-neutral-400">
              {byDay[0].date} ~ {byDay[byDay.length - 1].date}
            </span>
          </div>
          {(() => {
            const max = Math.max(...byDay.map((d) => d.total), 1);
            return (
              <div className="flex h-28 items-end gap-[3px]">
                {byDay.map((d) => (
                  <div
                    key={d.date}
                    className="group relative flex-1 rounded-t bg-primary-400/70 transition hover:bg-primary-500"
                    style={{ height: `${Math.max((d.total / max) * 100, 1.5)}%` }}
                    title={`${d.date} · ${fmt(d.total)} tokens · ${fmt(d.messageCount)} 条消息`}
                  />
                ))}
              </div>
            );
          })()}
        </section>
      )}

      {/* 会话明细 */}
      {sessions.length > 0 && (
        <section className="rounded-xl border border-neutral-200 bg-panel">
          <h3 className="border-b border-neutral-100 px-4 py-3 text-sm font-medium text-neutral-700">
            会话明细 ({sessions.length})
          </h3>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-neutral-50 text-left text-neutral-400">
                <tr>
                  {["时间", "项目", "模型", "输入", "输出", "缓存", "总计", "花费"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 text-neutral-600">
                {sessions.map((s) => (
                  <tr key={s.fileName + s.timestamp} className="hover:bg-neutral-50">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-500">
                      {new Date(s.timestamp).toLocaleString("zh-CN", {
                        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2" title={s.project}>
                      {projectLabel(s.project)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {s.provider ? `${s.provider} · ${s.model || "--"}` : s.model || "--"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{fmt(s.input)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmt(s.output)}</td>
                    <td className="px-3 py-2 tabular-nums" title={`读 ${fmt(s.cacheRead)} / 写 ${fmt(s.cacheWrite)}`}>
                      {fmt(s.cacheRead + s.cacheWrite)}
                    </td>
                    <td className="px-3 py-2 font-medium tabular-nums text-neutral-900">{fmt(s.total)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtCost(s.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 空态: 无数据且非加载中 */}
      {!loading && !error && summary && summary.total === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-200 px-4 py-10 text-center text-sm text-neutral-400">
          该筛选范围内暂无 token 数据
        </p>
      )}
    </div>
  );
}
