import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownToLine, ArrowUpFromLine, Bot, ChevronDown, ChevronRight, Coins,
  Database, DatabaseZap, DollarSign, EyeOff, FolderKanban, Loader2,
  MessageSquare, AlertCircle,
} from "lucide-react";
import { StatsFilterBar, projectLabel } from "./StatsFilterBar";
import {
  resolveQueryBounds,
  useStatsFilterStore,
} from "../../store/statsFilter";

// ---- 后端 get_token_stats 返回结构 ----
interface SessionRow {
  sessionId: string; fileName: string; project: string;
  // path = 索引 key 绝对路径, 全局唯一 (子会话文件名恒为 session.jsonl, 不能拿它组行 key)
  path: string;
  // cwd = 会话自身真实工作目录; project 是归属后的项目 (子会话跟父会话走)
  cwd: string;
  // agent = 归一化后的子代理名, 主会话为空; parentPath 为空表示顶层会话
  agent: string; parentPath: string;
  // 该会话内未落盘的前台同步 dispatch 次数 (这些子代理的 token 无处可查)
  opaqueDispatches: number;
  provider: string; model: string; timestamp: string; messageCount: number;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  total: number; cost: number;
}

interface TokenStatsResult {
  summary: {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    total: number; cost: number; messageCount: number; sessionCount: number;
    opaqueDispatches: number;
  };
  byDay: {
    date: string; input: number; output: number; cacheRead: number;
    cacheWrite: number; total: number; cost: number; messageCount: number;
  }[];
  sessions: SessionRow[];
  filters: { projects: string[]; providers: string[]; models: string[]; agents: string[] };
}

// 数值展示: token 用千分位, 花费保留 4 位小数
const fmt = (n: number) => n.toLocaleString();
const fmtCost = (n: number) => `$${n.toFixed(4)}`;

// 来源筛选哨兵 (与 Rust 侧 aggregate 的 agt 判定一一对应)
const SRC_MAIN = "__main__";
const SRC_SUB = "__sub__";

export function TokenStatsPanel() {
  // ---- 筛选条件: 时间+项目走共享 store (与行为统计同口径); provider/model/agent 是本面板私有 ----
  const range = useStatsFilterStore((s) => s.range);
  const customStart = useStatsFilterStore((s) => s.customStart);
  const customEnd = useStatsFilterStore((s) => s.customEnd);
  const project = useStatsFilterStore((s) => s.project);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [agent, setAgent] = useState("");
  // ---- 结果 ----
  const [data, setData] = useState<TokenStatsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 展开的顶层行 (纯视图状态, 不进 store —— 换筛选后重置是符合预期的行为)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
      agent: agent || null,
    })
      .then((res) => { if (reqId.current === id) { setData(res); setExpanded(new Set()); } })
      .catch((e) => { if (reqId.current === id) setError(String(e)); })
      .finally(() => { if (reqId.current === id) setLoading(false); });
  }, [range, customStart, customEnd, project, provider, model, agent]);

  const summary = data?.summary;
  const byDay = data?.byDay ?? [];
  const sessions = useMemo(() => data?.sessions ?? [], [data]);
  const filters = data?.filters;

  // 父子归并: 后端返回扁平行, 这里按 parentPath 分组。
  // 顶层 = 无父 或 父不在本次结果集内 (孤儿会话 / 父被 agent 筛选滤掉) —— 后者平铺顶层,
  // 因为此时用户问的是「这个 agent 花了多少」, 不该被父会话行干扰
  const { topRows, childrenOf } = useMemo(() => {
    const known = new Set(sessions.map((s) => s.path));
    const kids = new Map<string, SessionRow[]>();
    const tops: SessionRow[] = [];
    for (const s of sessions) {
      if (s.parentPath && known.has(s.parentPath)) {
        const arr = kids.get(s.parentPath);
        if (arr) arr.push(s);
        else kids.set(s.parentPath, [s]);
      } else {
        tops.push(s);
      }
    }
    for (const arr of kids.values()) {
      arr.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    return { topRows: tops, childrenOf: kids };
  }, [sessions]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

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

      {/* 筛选栏: 时间+项目共享组件, provider/model/agent 是本面板私有插槽 */}
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
        <select
          value={agent} onChange={(e) => setAgent(e.target.value)}
          className="rounded-lg border border-neutral-200 bg-panel px-2 py-1.5 text-neutral-700 outline-none focus:border-primary-400"
          title="按来源筛选: 主会话 / 子代理"
        >
          <option value="">全部来源</option>
          <option value={SRC_MAIN}>仅主会话</option>
          <option value={SRC_SUB}>仅子代理</option>
          {(filters?.agents ?? []).map((a) => (
            <option key={a} value={a}>{a}</option>
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

      {/* 不可见量提示条: 前台同步子代理的 token 根本没落盘, 只能如实说明有多少次算不到。
          不做任何估算 —— 没有的数据就是没有 */}
      {summary && summary.opaqueDispatches > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/50 px-4 py-3 text-xs leading-relaxed text-neutral-600">
          <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div>
            另有 <span className="font-semibold tabular-nums text-neutral-900">{fmt(summary.opaqueDispatches)}</span> 次
            前台同步子代理调用, pi 未落盘其 token, <span className="font-medium">无法计入</span>上方统计 —— 实际消耗高于此处显示。
            <span className="text-neutral-400">（该计数只随时间与项目筛选变化, 不受供应商 / 模型 / 来源筛选影响）</span>
          </div>
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

      {/* 会话明细: 顶层会话可展开, 其下挂该会话派出的子代理 */}
      {topRows.length > 0 && (
        <section className="rounded-xl border border-neutral-200 bg-panel">
          <h3 className="border-b border-neutral-100 px-4 py-3 text-sm font-medium text-neutral-700">
            会话明细 ({topRows.length}
            {sessions.length > topRows.length && ` + ${sessions.length - topRows.length} 子代理`})
          </h3>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-neutral-50 text-left text-neutral-400">
                <tr>
                  {["时间", "项目 / 来源", "模型", "输入", "输出", "缓存", "总计", "花费"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 text-neutral-600">
                {topRows.map((s) => {
                  const kids = childrenOf.get(s.path) ?? [];
                  const open = expanded.has(s.path);
                  // 顶层行数值 = 自身 + 子代理合计, 一眼能看到这轮对话的真实总花费
                  const sum = kids.reduce(
                    (a, k) => ({
                      input: a.input + k.input, output: a.output + k.output,
                      cache: a.cache + k.cacheRead + k.cacheWrite,
                      total: a.total + k.total, cost: a.cost + k.cost,
                    }),
                    {
                      input: s.input, output: s.output,
                      cache: s.cacheRead + s.cacheWrite, total: s.total, cost: s.cost,
                    },
                  );
                  const kidTotal = sum.total - s.total;
                  return (
                    <Fragment key={s.path}>
                      <tr className="hover:bg-neutral-50">
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-500">
                          <div className="flex items-center gap-1">
                            {kids.length > 0 ? (
                              <button
                                onClick={() => toggle(s.path)}
                                className="rounded p-0.5 text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-700"
                                title={open ? "收起子代理" : `展开 ${kids.length} 个子代理`}
                              >
                                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                              </button>
                            ) : (
                              /* 无子行也占位, 保证列对齐 */
                              <span className="inline-block h-3.5 w-[1.125rem]" />
                            )}
                            {new Date(s.timestamp).toLocaleString("zh-CN", {
                              month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                            })}
                          </div>
                        </td>
                        <td className="max-w-[200px] px-3 py-2" title={s.cwd || s.project}>
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{projectLabel(s.project)}</span>
                            {s.agent && (
                              <span className="flex shrink-0 items-center gap-0.5 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                                <Bot className="h-3 w-3" />
                                {s.agent}
                              </span>
                            )}
                            {s.opaqueDispatches > 0 && (
                              <span
                                className="flex shrink-0 items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600"
                                title={`该会话有 ${s.opaqueDispatches} 次前台同步子代理调用, 其 token 未被 pi 落盘, 无法计入`}
                              >
                                <EyeOff className="h-3 w-3" />
                                {s.opaqueDispatches}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {s.provider ? `${s.provider} · ${s.model || "--"}` : s.model || "--"}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{fmt(sum.input)}</td>
                        <td className="px-3 py-2 tabular-nums">{fmt(sum.output)}</td>
                        <td className="px-3 py-2 tabular-nums">{fmt(sum.cache)}</td>
                        <td className="px-3 py-2 font-medium tabular-nums text-neutral-900">
                          {fmt(sum.total)}
                          {kidTotal > 0 && (
                            <span className="ml-1 text-[10px] font-normal text-neutral-400">
                              其中子代理 {fmt(kidTotal)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{fmtCost(sum.cost)}</td>
                      </tr>
                      {open &&
                        kids.map((k) => (
                          <tr key={k.path} className="bg-neutral-50/40 text-neutral-500 hover:bg-neutral-50">
                            <td className="whitespace-nowrap py-1.5 pl-9 pr-3 tabular-nums">
                              {new Date(k.timestamp).toLocaleString("zh-CN", {
                                month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                              })}
                            </td>
                            <td className="max-w-[200px] px-3 py-1.5" title={k.cwd}>
                              <span className="flex items-center gap-0.5 text-[10px]">
                                <Bot className="h-3 w-3 shrink-0 text-neutral-400" />
                                {k.agent || "子代理"}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-1.5">
                              {k.provider ? `${k.provider} · ${k.model || "--"}` : k.model || "--"}
                            </td>
                            <td className="px-3 py-1.5 tabular-nums">{fmt(k.input)}</td>
                            <td className="px-3 py-1.5 tabular-nums">{fmt(k.output)}</td>
                            <td className="px-3 py-1.5 tabular-nums">{fmt(k.cacheRead + k.cacheWrite)}</td>
                            <td className="px-3 py-1.5 tabular-nums">{fmt(k.total)}</td>
                            <td className="px-3 py-1.5 tabular-nums">{fmtCost(k.cost)}</td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
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
