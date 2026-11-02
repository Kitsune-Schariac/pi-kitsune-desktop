import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownToLine, ArrowUpFromLine, Bot, ChevronDown, ChevronRight, Coins,
  Database, DollarSign, EyeOff, FolderKanban,
  MessageSquare, AlertCircle, Percent,
} from "lucide-react";
import { StatsFilterBar, projectLabel } from "./StatsFilterBar";
import { Badge, Card, EmptyHint, Select } from "../ui";
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

/**
 * 区间累计口径的缓存命中率 —— ΣcacheRead ÷ Σ(input + cacheRead + cacheWrite)。
 *
 * 注意与输入框实时栏的 CH 不是同一个口径: 这里回答「这段时间缓存省了多少」, 那边回答
 * 「缓存此刻生效吗」(最近一次调用)。两者数值本来就不应相等, UI 上用 title 标清楚。
 * 分母为 0 (该范围无数据 / provider 不上报缓存) 时返回占位符, 不出 NaN。
 */
const hitRate = (cacheRead: number, cacheWrite: number, input: number) => {
  const denom = input + cacheRead + cacheWrite;
  return denom > 0 ? `${((cacheRead / denom) * 100).toFixed(1)}%` : "—";
};

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
    <div className="mx-auto max-w-[1200px] space-y-6 px-8 py-8">
      {/* 加载/错误状态条 (大标题已由设置窗页头承担, 这里不再重复渲染 h2) */}
      {error && (
        <div className="flex items-center gap-2 text-body text-err">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* 筛选栏: 时间+项目共享组件, provider/model/agent 是本面板私有插槽 */}
      <StatsFilterBar projects={filters?.projects ?? []}>
        <Select
          value={provider}
          onChange={setProvider}
          title="按供应商筛选"
          className="w-[140px]"
          options={[
            { value: "", label: "全部供应商" },
            ...(filters?.providers ?? []).map((p) => ({ value: p, label: p })),
          ]}
        />
        <Select
          value={model}
          onChange={setModel}
          title="按模型筛选"
          className="w-[160px]"
          options={[
            { value: "", label: "全部模型" },
            ...(filters?.models ?? []).map((m) => ({ value: m, label: m })),
          ]}
        />
        <Select
          value={agent}
          onChange={setAgent}
          title="按来源筛选: 主会话 / 子代理"
          className="w-[140px]"
          options={[
            { value: "", label: "全部来源" },
            { value: SRC_MAIN, label: "仅主会话" },
            { value: SRC_SUB, label: "仅子代理" },
            ...(filters?.agents ?? []).map((a) => ({ value: a, label: a })),
          ]}
        />
      </StatsFilterBar>

      {/* 汇总卡片: 固定 8 张 (4×2 网格)。缓存读/写合并为一张, 腾出的格子给命中率 ——
          命中的相对值比读写的绝对值更能回答「缓存到底好不好」 */}
      {summary && (
        <div className={`grid grid-cols-4 gap-4 transition-opacity duration-base ${loading ? "opacity-50" : ""}`}>
          {[
            { label: "输入", value: fmt(summary.input), icon: ArrowDownToLine },
            { label: "输出", value: fmt(summary.output), icon: ArrowUpFromLine },
            {
              label: "缓存", value: fmt(summary.cacheRead + summary.cacheWrite), icon: Database,
              sub: `读 ${fmt(summary.cacheRead)} · 写 ${fmt(summary.cacheWrite)}`,
              title: "缓存读 + 缓存写合计",
            },
            {
              label: "缓存命中率", icon: Percent,
              value: hitRate(summary.cacheRead, summary.cacheWrite, summary.input),
              sub: "区间累计",
              title: "区间累计口径: ΣcacheRead ÷ Σ(input + cacheRead + cacheWrite), 缓存写入按未命中计。\n与输入框底部的 CH (最近一次调用口径) 不同, 两者数值不应相等",
            },
            { label: "总计", value: fmt(summary.total), icon: Coins },
            { label: "花费", value: fmtCost(summary.cost), icon: DollarSign },
            { label: "消息数", value: fmt(summary.messageCount), icon: MessageSquare },
            { label: "会话数", value: fmt(summary.sessionCount), icon: FolderKanban },
          ].map(({ label, value, icon: Icon, sub, title }) => (
            <Card key={label} padded title={title}>
              <div className="mb-2 flex items-center gap-2 text-label text-fg-3">
                <Icon className="h-[14px] w-[14px] text-fg-4" />
                {label}
              </div>
              <div className="text-num font-medium tabular-nums text-fg">{value}</div>
              <div className="mt-1 h-[18px] truncate text-label tabular-nums text-fg-4">{sub ?? ""}</div>
            </Card>
          ))}
        </div>
      )}

      {/* 不可见量提示条: 前台同步子代理的 token 根本没落盘, 只能如实说明有多少次算不到。
          不做任何估算 —— 没有的数据就是没有 */}
      {summary && summary.opaqueDispatches > 0 && (
        <Card className="flex items-start gap-3 px-4 py-3 text-body leading-relaxed text-fg-2">
          <EyeOff className="mt-[3px] h-4 w-4 shrink-0 text-warn" />
          <div>
            另有 <span className="font-semibold tabular-nums text-fg">{fmt(summary.opaqueDispatches)}</span> 次
            前台同步子代理调用, pi 未落盘其 token, <span className="font-medium">无法计入</span>上方统计 —— 实际消耗高于此处显示。
            <span className="text-fg-4">（该计数只随时间与项目筛选变化, 不受供应商 / 模型 / 来源筛选影响）</span>
          </div>
        </Card>
      )}

      {/* 按天趋势 (纯 CSS bar, 高度按当日总量归一化) */}
      {byDay.length > 0 && (
        <Card padded>
          <div className="mb-4 flex items-baseline justify-between">
            <h3 className="text-lead font-semibold text-fg">按天趋势</h3>
            <span className="text-label tabular-nums text-fg-4">
              {byDay[0].date} ~ {byDay[byDay.length - 1].date}
            </span>
          </div>
          {(() => {
            const max = Math.max(...byDay.map((d) => d.total), 1);
            return (
              <div className="flex h-32 items-end gap-2">
                {byDay.map((d) => (
                  <div
                    key={d.date}
                    className="group relative flex-1 rounded-[6px] bg-fg/15 transition duration-fast ease-out hover:bg-fg/70"
                    style={{ height: `${Math.max((d.total / max) * 100, 1.5)}%` }}
                    title={`${d.date} · ${fmt(d.total)} tokens · ${fmt(d.messageCount)} 条消息 · 命中率 ${hitRate(d.cacheRead, d.cacheWrite, d.input)}`}
                  />
                ))}
              </div>
            );
          })()}
        </Card>
      )}

      {/* 会话明细: 顶层会话可展开, 其下挂该会话派出的子代理 */}
      {topRows.length > 0 && (
        <Card className="overflow-hidden">
          <h3 className="border-b border-line px-4 py-3 text-lead font-semibold text-fg">
            会话明细 ({topRows.length}
            {sessions.length > topRows.length && ` + ${sessions.length - topRows.length} 子代理`})
          </h3>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-body">
              <thead className="sticky top-0 z-[1] bg-well text-left text-label text-fg-3">
                <tr>
                  {["时间", "项目 / 来源", "模型", "输入", "输出", "缓存", "命中", "总计", "花费"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium first:pl-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-fg-2">
                {topRows.map((s) => {
                  const kids = childrenOf.get(s.path) ?? [];
                  const open = expanded.has(s.path);
                  // 顶层行数值 = 自身 + 子代理合计, 一眼能看到这轮对话的真实总花费。
                  // cacheRead/cacheWrite 分开累计: 命中率要的是 read 单独的值, 不能像「缓存」列那样合并
                  const sum = kids.reduce(
                    (a, k) => ({
                      input: a.input + k.input, output: a.output + k.output,
                      cacheRead: a.cacheRead + k.cacheRead, cacheWrite: a.cacheWrite + k.cacheWrite,
                      total: a.total + k.total, cost: a.cost + k.cost,
                    }),
                    {
                      input: s.input, output: s.output,
                      cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, total: s.total, cost: s.cost,
                    },
                  );
                  const kidTotal = sum.total - s.total;
                  return (
                    <Fragment key={s.path}>
                      <tr className="hover:bg-hover">
                        <td className="whitespace-nowrap py-2 pl-4 pr-3 tabular-nums text-fg-3">
                          <div className="flex items-center gap-1">
                            {kids.length > 0 ? (
                              <button
                                onClick={() => toggle(s.path)}
                                className="rounded-sm p-1 text-fg-4 transition duration-fast ease-out hover:bg-hover hover:text-fg"
                                title={open ? "收起子代理" : `展开 ${kids.length} 个子代理`}
                              >
                                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                            ) : (
                              /* 无子行也占位, 保证列对齐 */
                              <span className="inline-block h-4 w-[1.125rem]" />
                            )}
                            {new Date(s.timestamp).toLocaleString("zh-CN", {
                              month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                            })}
                          </div>
                        </td>
                        <td className="max-w-[200px] px-3 py-2" title={s.cwd || s.project}>
                          <div className="flex items-center gap-2">
                            <span className="truncate">{projectLabel(s.project)}</span>
                            {s.agent && (
                              <Badge>
                                <Bot className="h-3 w-3" />
                                {s.agent}
                              </Badge>
                            )}
                            {s.opaqueDispatches > 0 && (
                              <Badge
                                tone="warn"
                                title={`该会话有 ${s.opaqueDispatches} 次前台同步子代理调用, 其 token 未被 pi 落盘, 无法计入`}
                              >
                                <EyeOff className="h-3 w-3" />
                                {s.opaqueDispatches}
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {s.provider ? `${s.provider} · ${s.model || "--"}` : s.model || "--"}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{fmt(sum.input)}</td>
                        <td className="px-3 py-2 tabular-nums">{fmt(sum.output)}</td>
                        <td className="px-3 py-2 tabular-nums">{fmt(sum.cacheRead + sum.cacheWrite)}</td>
                        <td className="px-3 py-2 tabular-nums">{hitRate(sum.cacheRead, sum.cacheWrite, sum.input)}</td>
                        <td className="px-3 py-2 font-medium tabular-nums text-fg">
                          {fmt(sum.total)}
                          {kidTotal > 0 && (
                            <span className="ml-1 text-meta font-normal text-fg-4">
                              其中子代理 {fmt(kidTotal)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{fmtCost(sum.cost)}</td>
                      </tr>
                      {open &&
                        kids.map((k) => (
                          <tr key={k.path} className="bg-well text-fg-3 hover:bg-hover">
                            <td className="whitespace-nowrap py-2 pl-9 pr-3 tabular-nums">
                              {new Date(k.timestamp).toLocaleString("zh-CN", {
                                month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                              })}
                            </td>
                            <td className="max-w-[200px] px-3 py-2" title={k.cwd}>
                              <span className="flex items-center gap-1 text-meta">
                                <Bot className="h-3 w-3 shrink-0 text-fg-4" />
                                {k.agent || "子代理"}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">
                              {k.provider ? `${k.provider} · ${k.model || "--"}` : k.model || "--"}
                            </td>
                            <td className="px-3 py-2 tabular-nums">{fmt(k.input)}</td>
                            <td className="px-3 py-2 tabular-nums">{fmt(k.output)}</td>
                            <td className="px-3 py-2 tabular-nums">{fmt(k.cacheRead + k.cacheWrite)}</td>
                            <td className="px-3 py-2 tabular-nums">{hitRate(k.cacheRead, k.cacheWrite, k.input)}</td>
                            <td className="px-3 py-2 tabular-nums">{fmt(k.total)}</td>
                            <td className="px-3 py-2 tabular-nums">{fmtCost(k.cost)}</td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* 空态: 无数据且非加载中 */}
      {!loading && !error && summary && summary.total === 0 && (
        <EmptyHint title="该筛选范围内暂无 token 数据" />
      )}
    </div>
  );
}
