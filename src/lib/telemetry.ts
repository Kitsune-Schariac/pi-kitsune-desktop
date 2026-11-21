// 会话遥测纯函数引擎: 上下文成分解剖 / Token 构成 / 费用拆解与缓存节省 / 模型执行动作解析。
// 只引入类型与纯函数 (不引入 store), 保证单测友好、零副作用。
import type { CostBreakdown } from "./agent";
import type { ChatEntry, SessionState, TurnStats } from "../store/session";
import { cacheHitRate } from "./cacheHit";
import { extractResultText, extractSubagentDetails, stepDiffStat, stepDuration, SUBAGENT_TOOLS } from "./timeline";

type ContextUsage = NonNullable<SessionState["contextUsage"]>;
type TokenStats = NonNullable<SessionState["tokenStats"]>;

/** 单价结构 (USD / 1M tokens, 与 models.json 的 cost 四主键对齐) */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** token 数缩写: 12.3k / 1.2M */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return String(Math.round(n));
}

/** 费用格式: $0 / $0.0042 / $1.23 */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** 紧凑耗时: 0.4s / 12s / 2m 15s */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ============================================================
// 1. 上下文成分解剖
// ============================================================

export interface ContextSegment {
  key: "conversation" | "thinking" | "tools" | "system";
  label: string;
  estTokens: number;
  shareOfUsed: number;   // 占已用上下文的百分比 (0~100)
  shareOfWindow: number; // 占整个窗口的百分比 (0~100)
  vizVar: string;        // CSS var(--viz-*)
}

export interface ContextAnalysis {
  used: number | null;
  window: number;
  remaining: number | null;
  percent: number | null;
  level: "ok" | "warn" | "danger" | "unknown";
  segments: ContextSegment[];
  hasBreakdown: boolean;
}

function estimateArgsChars(args: unknown): number {
  if (!args) return 0;
  if (typeof args === "string") return args.length;
  try {
    return JSON.stringify(args).length;
  } catch {
    return 0;
  }
}

export function analyzeContext(
  contextUsage: ContextUsage | null,
  entries: ChatEntry[] | undefined,
): ContextAnalysis {
  const window = contextUsage?.contextWindow ?? 0;
  const used = contextUsage?.tokens ?? null;
  const percent =
    contextUsage?.percent != null
      ? Math.max(0, Math.min(100, contextUsage.percent))
      : used != null && window > 0
        ? Math.max(0, Math.min(100, (used / window) * 100))
        : null;
  const remaining = used != null && window > 0 ? Math.max(0, window - used) : null;
  const level: ContextAnalysis["level"] =
    percent == null ? "unknown" : percent >= 85 ? "danger" : percent >= 70 ? "warn" : "ok";

  let convChars = 0;
  let thinkChars = 0;
  let toolChars = 0;

  for (const e of entries ?? []) {
    if (e.kind === "message") {
      if (e.text) convChars += e.text.length;
      if (e.thinking) thinkChars += e.thinking.length;
    } else if (e.kind === "tool") {
      toolChars += estimateArgsChars(e.args) + extractResultText(e.result).length;
    }
  }

  const totalChars = convChars + thinkChars + toolChars;
  if (used == null || used <= 0 || totalChars === 0) {
    return { used, window, remaining, percent, level, segments: [], hasBreakdown: false };
  }

  // 粗估每 token ~3.2 字符 (中英代码混合会话均值); 超过 used 说明经过了压缩或编码密度更高, 按比例归一到 used;
  // 若低于 used, 差额归为系统提示/工具定义等基础开销 (System & Schema)
  const rawConv = convChars / 3.2;
  const rawThink = thinkChars / 3.2;
  const rawTool = toolChars / 3.2;
  const rawSum = rawConv + rawThink + rawTool;
  const scale = rawSum > used ? used / rawSum : 1;

  const estConv = Math.round(rawConv * scale);
  const estThink = Math.round(rawThink * scale);
  const estTool = Math.round(rawTool * scale);
  const estSystem = Math.max(0, used - estConv - estThink - estTool);

  const mk = (
    key: ContextSegment["key"],
    label: string,
    estTokens: number,
    vizVar: string,
  ): ContextSegment => ({
    key,
    label,
    estTokens,
    shareOfUsed: used > 0 ? (estTokens / used) * 100 : 0,
    shareOfWindow: window > 0 ? (estTokens / window) * 100 : 0,
    vizVar,
  });

  const segments = [
    mk("conversation", "对话正文", estConv, "var(--viz-2)"),
    mk("tools", "工具调用与输出", estTool, "var(--viz-6)"),
    mk("thinking", "思考链", estThink, "var(--viz-5)"),
    mk("system", "系统与工具定义", estSystem, "var(--viz-4)"),
  ].filter((s) => s.estTokens > 0);

  return { used, window, remaining, percent, level, segments, hasBreakdown: segments.length > 0 };
}

// ============================================================
// 2. Token 构成解析
// ============================================================

export interface TokenBucket {
  key: "cacheRead" | "uncachedInput" | "cacheWrite" | "output";
  label: string;
  tokens: number;
  percent: number; // 占总 token 的百分比
  vizVar: string;
}

export interface TokenAnalysis {
  hasData: boolean;
  total: number;
  promptTotal: number;
  buckets: TokenBucket[];
  /** 最近一次调用缓存命中率 (与底部输入卡同口径) */
  lastHitRate: number | null;
  /** 整会话累计缓存命中率: cacheRead / (input + cacheRead + cacheWrite) */
  sessionHitRate: number | null;
  cacheActive: boolean;
}

export function analyzeTokens(
  tokenStats: TokenStats | null,
  turnStats: TurnStats | null,
): TokenAnalysis {
  if (!tokenStats) {
    return {
      hasData: false,
      total: 0,
      promptTotal: 0,
      buckets: [],
      lastHitRate: cacheHitRate(turnStats, null),
      sessionHitRate: null,
      cacheActive: turnStats?.cacheSeen ?? false,
    };
  }
  const { input, output, cacheRead, cacheWrite } = tokenStats.tokens;
  const total = Math.max(tokenStats.tokens.total, input + output + cacheRead + cacheWrite);
  const promptTotal = input + cacheRead + cacheWrite;
  const cacheActive = cacheRead > 0 || cacheWrite > 0 || (turnStats?.cacheSeen ?? false);
  const sessionHitRate = cacheActive && promptTotal > 0 ? (cacheRead / promptTotal) * 100 : null;
  const lastHitRate = cacheHitRate(turnStats, tokenStats);

  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const buckets: TokenBucket[] = [
    { key: "cacheRead", label: "缓存命中读", tokens: cacheRead, percent: pct(cacheRead), vizVar: "var(--viz-1)" },
    { key: "uncachedInput", label: "未命中输入", tokens: input, percent: pct(input), vizVar: "var(--viz-4)" },
    { key: "cacheWrite", label: "缓存写入", tokens: cacheWrite, percent: pct(cacheWrite), vizVar: "var(--viz-3)" },
    { key: "output", label: "模型输出", tokens: output, percent: pct(output), vizVar: "var(--viz-2)" },
  ];

  return {
    hasData: total > 0,
    total,
    promptTotal,
    buckets,
    lastHitRate,
    sessionHitRate,
    cacheActive,
  };
}

// ============================================================
// 3. 费用解析与缓存节省估算
// ============================================================

export interface CostItem {
  key: "cacheRead" | "input" | "cacheWrite" | "output";
  label: string;
  cost: number;
  percent: number;
  vizVar: string;
}

export interface CostAnalysis {
  hasCost: boolean;
  total: number | null;
  turnCost: number | null;
  avgTurnCost: number | null;
  estimated: boolean;
  items: CostItem[];
  /** 缓存读相比按未命中输入计费省下的费用 (USD); 无法可靠推算时为 null */
  cacheSavedUsd: number | null;
  /** 节省比例: saved / (total + saved) * 100 */
  cacheSavedPercent: number | null;
}

export function analyzeCost(
  tokenStats: TokenStats | null,
  turnStats: TurnStats | null,
  costDetail: CostBreakdown | null,
  pricing: ModelPricing | null,
): CostAnalysis {
  const total = tokenStats ? tokenStats.cost : null;
  const hasCost = total != null && total > 0;
  const turnCost = turnStats && turnStats.cost > 0 ? turnStats.cost : null;
  const turns = tokenStats?.userMessages ?? 0;
  const avgTurnCost = hasCost && turns > 0 ? total! / turns : null;

  let detail: CostBreakdown | null = costDetail;
  let estimated = false;

  // 若真实分项不可得, 但有模型单价且有 token 统计, 则按单价推算并标记 estimated
  if (!detail && tokenStats && pricing) {
    const t = tokenStats.tokens;
    const input = (t.input / 1_000_000) * pricing.input;
    const output = (t.output / 1_000_000) * pricing.output;
    const cacheRead = (t.cacheRead / 1_000_000) * pricing.cacheRead;
    const cacheWrite = (t.cacheWrite / 1_000_000) * pricing.cacheWrite;
    const sum = input + output + cacheRead + cacheWrite;
    if (sum > 0) {
      detail = { input, output, cacheRead, cacheWrite, total: sum };
      estimated = true;
    }
  }

  const denom = detail
    ? detail.input + detail.output + detail.cacheRead + detail.cacheWrite
    : 0;

  const items: CostItem[] =
    detail && denom > 0
      ? [
          { key: "output", label: "模型输出", cost: detail.output, percent: (detail.output / denom) * 100, vizVar: "var(--viz-2)" },
          { key: "input", label: "未命中输入", cost: detail.input, percent: (detail.input / denom) * 100, vizVar: "var(--viz-4)" },
          { key: "cacheWrite", label: "缓存写入", cost: detail.cacheWrite, percent: (detail.cacheWrite / denom) * 100, vizVar: "var(--viz-3)" },
          { key: "cacheRead", label: "缓存命中读", cost: detail.cacheRead, percent: (detail.cacheRead / denom) * 100, vizVar: "var(--viz-1)" },
        ]
      : [];

  // 缓存节省估算: 仅在存在 cacheRead 且拿到可靠的 input vs cacheRead 单价差时给出
  let cacheSavedUsd: number | null = null;
  let cacheSavedPercent: number | null = null;
  const crTokens = tokenStats?.tokens.cacheRead ?? 0;
  if (crTokens > 0) {
    let unitInput: number | null = null;
    let unitCacheRead: number | null = null;
    if (pricing && pricing.input > 0 && pricing.input > pricing.cacheRead) {
      unitInput = pricing.input / 1_000_000;
      unitCacheRead = pricing.cacheRead / 1_000_000;
    } else if (detail && tokenStats && tokenStats.tokens.input > 0 && detail.input > 0) {
      const ui = detail.input / tokenStats.tokens.input;
      const uc = detail.cacheRead / crTokens;
      if (ui > uc) {
        unitInput = ui;
        unitCacheRead = uc;
      }
    }
    if (unitInput != null && unitCacheRead != null) {
      const saved = crTokens * (unitInput - unitCacheRead);
      if (saved > 0.0001) {
        cacheSavedUsd = saved;
        const baseTotal = total ?? denom;
        if (baseTotal > 0) {
          cacheSavedPercent = (saved / (baseTotal + saved)) * 100;
        }
      }
    }
  }

  return {
    hasCost: hasCost || denom > 0,
    total: hasCost ? total : denom > 0 ? denom : total,
    turnCost,
    avgTurnCost,
    estimated,
    items,
    cacheSavedUsd,
    cacheSavedPercent,
  };
}

// ============================================================
// 4. 模型执行动作解析
// ============================================================

export type ActionCategoryKey = "read" | "edit" | "exec" | "agent" | "other";

export interface ActionCategory {
  key: ActionCategoryKey;
  label: string;
  count: number;
  errors: number;
  durationSec: number;
  hasDuration: boolean;
  vizVar: string;
}

export interface ActionAnalysis {
  totalTools: number;
  runningTools: number;
  errorTools: number;
  totalDurationSec: number | null;
  linesAdded: number;
  linesDeleted: number;
  thinkingRatio: number | null; // 0~100; 无 thinking 时 null
  categories: ActionCategory[];
  topTools: [string, number][];
  lastErrorStepId: string | null;
}

const READ_TOOLS = new Set([
  "read", "read_file", "view_file", "grep", "grep_search", "find", "find_by_name",
  "glob", "ls", "list_dir", "search", "web_search", "search_web", "fetch",
]);
const EDIT_TOOLS = new Set([
  "edit", "write", "write_file", "edit_file", "multi_edit", "patch", "replace_file_content",
  "multi_replace_file_content", "notebook_edit",
]);
const EXEC_TOOLS = new Set([
  "bash", "shell", "exec", "run_command", "terminal", "powershell",
]);

function classifyTool(entry: ChatEntry): ActionCategoryKey {
  const name = (entry.toolName ?? "").toLowerCase();
  if (SUBAGENT_TOOLS.has(name) || extractSubagentDetails(entry.result) !== null || name === "agent" || name === "task") {
    return "agent";
  }
  if (EDIT_TOOLS.has(name)) return "edit";
  if (EXEC_TOOLS.has(name)) return "exec";
  if (READ_TOOLS.has(name)) return "read";
  return "other";
}

export function analyzeActions(entries: ChatEntry[] | undefined): ActionAnalysis {
  const buckets: Record<ActionCategoryKey, ActionCategory> = {
    read: { key: "read", label: "探索读取", count: 0, errors: 0, durationSec: 0, hasDuration: false, vizVar: "var(--viz-2)" },
    edit: { key: "edit", label: "代码变更", count: 0, errors: 0, durationSec: 0, hasDuration: false, vizVar: "var(--viz-1)" },
    exec: { key: "exec", label: "命令执行", count: 0, errors: 0, durationSec: 0, hasDuration: false, vizVar: "var(--viz-3)" },
    agent: { key: "agent", label: "子代理", count: 0, errors: 0, durationSec: 0, hasDuration: false, vizVar: "var(--viz-5)" },
    other: { key: "other", label: "其他工具", count: 0, errors: 0, durationSec: 0, hasDuration: false, vizVar: "var(--viz-4)" },
  };

  let totalTools = 0;
  let runningTools = 0;
  let errorTools = 0;
  let totalDur = 0;
  let hasAnyDur = false;
  let linesAdded = 0;
  let linesDeleted = 0;
  let thinkingChars = 0;
  let textChars = 0;
  let lastErrorStepId: string | null = null;
  const toolCounts = new Map<string, number>();

  for (const e of entries ?? []) {
    if (e.kind === "message" && e.role === "assistant") {
      if (e.thinking) thinkingChars += e.thinking.length;
      if (e.text) textChars += e.text.length;
      continue;
    }
    if (e.kind !== "tool") continue;

    totalTools += 1;
    if (e.status === "running") runningTools += 1;
    if (e.status === "error") {
      errorTools += 1;
      lastErrorStepId = e.id;
    }

    const toolName = e.toolName ?? "unknown";
    toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);

    const cat = buckets[classifyTool(e)];
    cat.count += 1;
    if (e.status === "error") cat.errors += 1;

    const d = stepDuration(e);
    if (d != null && d >= 0) {
      cat.durationSec += d;
      cat.hasDuration = true;
      totalDur += d;
      hasAnyDur = true;
    }

    const diff = stepDiffStat(e);
    if (diff) {
      linesAdded += diff.add;
      linesDeleted += diff.del;
    }
  }

  const thinkingRatio =
    thinkingChars > 0 && thinkingChars + textChars > 0
      ? (thinkingChars / (thinkingChars + textChars)) * 100
      : null;

  const categories = (Object.values(buckets) as ActionCategory[])
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);

  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);

  return {
    totalTools,
    runningTools,
    errorTools,
    totalDurationSec: hasAnyDur ? totalDur : null,
    linesAdded,
    linesDeleted,
    thinkingRatio,
    categories,
    topTools,
    lastErrorStepId,
  };
}
