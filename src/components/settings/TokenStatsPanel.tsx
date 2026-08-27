import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownToLine, ArrowUpFromLine, Coins, Database, DatabaseZap,
  DollarSign, FolderKanban, Loader2, MessageSquare, AlertCircle,
} from "lucide-react";
import { StatsFilterBar, projectLabel } from "./StatsFilterBar";
import {
  resolveQueryBounds,
  useStatsFilterStore,
} from "../../store/statsFilter";

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

// 数值展示: token 用千分位, 花费保留 4 位小数
const fmt = (n: number) => n.toLocaleString();
const fmtCost = (n: number) => `$${n.toFixed(4)}`;

export function TokenStatsPanel() {
  // ---- 筛选条件: 时间+项目走共享 store (与行为统计同口径); provider/model 是本面板私有 ----
  const range = useStatsFilterStore((s) => s.range);
  const customStart = useStatsFilterStore((s) => s.customStart);
  const customEnd = useStatsFilterStore((s) => s.customEnd);
  const project = useStatsFilterStore((s) => s.project);
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
    const { startTime, endTime } = resolveQueryBounds({ range, customStart, customEnd });
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

      {/* 筛选栏: 时间+项目共享组件, provider/model 是本面板私有插槽 */}
      <StatsFilterBar projects={filters?.projects ?? []}>
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
      </StatsFilterBar>
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
