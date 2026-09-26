// 时间线纯函数 (design §4.1): ChatEntry[] → 轮/条目结构 + 步骤摘要与统计。
// 只 import ChatEntry 类型, 不引任何 store —— research/tests/timeline.test.mjs 在 node 里
// bundle 后直接跑本文件, 一旦引入运行时依赖整个测试就挂。
import type { ChatEntry } from "../store/session";

export type TimelineItem =
  | { kind: "prompt"; entry: ChatEntry } // user message
  | { kind: "reply"; entry: ChatEntry } // assistant message (text + thinking)
  | { kind: "steps"; id: string; entries: ChatEntry[] } // 连续 tool 条目聚合; id = 首条 entry.id
  | { kind: "notice"; entry: ChatEntry }; // notification

export interface Turn {
  id: string;
  items: TimelineItem[];
}

// subagent 工具族: 识别口径与旧 ToolCallCard 一致 (工具名命中 OR result.details 含 subagent 字段)
export const SUBAGENT_TOOLS = new Set(["subagent", "subagent_wait"]);

/**
 * entries → 轮结构 (O(n) 单趟)。
 * 每条用户消息开一轮; 首个用户消息之前的条目 (欢迎语/通知等) 归 id="head" 的无标题轮;
 * 连续 tool 条目聚成一个步骤组, 遇到消息/通知或新轮即断开。
 * 历史回放里同一条 assistant 消息的 toolCall 条目排在其 text 之前, 这里按原顺序渲染, 不重排。
 */
export function buildTimeline(entries: ChatEntry[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null; // null = 尚未遇到任何用户消息 (head 阶段)
  let steps: ChatEntry[] | null = null; // 当前打开的步骤组

  // 首个 prompt 之前出现条目时惰性建 head 轮, 之后的条目都挂它下面
  const activeTurn = (): Turn => {
    if (!current) {
      current = { id: "head", items: [] };
      turns.push(current);
    }
    return current;
  };

  for (const entry of entries) {
    if (entry.kind === "message" && entry.role === "user") {
      current = { id: entry.id, items: [{ kind: "prompt", entry }] };
      turns.push(current);
      steps = null;
    } else if (entry.kind === "message") {
      activeTurn().items.push({ kind: "reply", entry });
      steps = null;
    } else if (entry.kind === "tool") {
      if (steps) {
        // 组内直接追加: item.entries 与 steps 是同一数组引用, 无需回写
        steps.push(entry);
      } else {
        steps = [entry];
        activeTurn().items.push({ kind: "steps", id: entry.id, entries: steps });
      }
    } else if (entry.kind === "notification") {
      activeTurn().items.push({ kind: "notice", entry });
      steps = null;
    }
  }
  return turns;
}

/**
 * 步骤一行摘要 (修 P1: 旧卡片取 JSON 缩进首行, 永远显示 "{")。
 * 口径: bash → 命令首行 (去掉开头 `cd <dir> &&` 导航前缀, 只留真正在跑的指令);
 * subagent 族 → agent 名 + task 首行; 文件类 → path/file_path; 其余 → 首个字符串参数;
 * 都没有 → 工具名。任何输入都返回可读文本, 不返回 JSON 花括号。
 */
export function summarizeStep(entry: ChatEntry): string {
  const args = entry.args;
  const tool = entry.toolName ?? "";

  if (typeof args === "string") {
    const first = args.split("\n")[0].trim();
    return first || tool;
  }
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (tool === "bash" && typeof a.command === "string") {
      const first = a.command.split("\n")[0].trim();
      return first.replace(/^cd\s+\S+\s*&&\s*/, "") || tool;
    }
    const agent = typeof a.agent === "string" ? a.agent : undefined;
    // 双重识别与旧 ToolCallCard 一致: 工具名命中, 或参数同时带 agent + task
    if (agent && (SUBAGENT_TOOLS.has(tool) || typeof a.task === "string")) {
      const task = typeof a.task === "string" ? a.task.split("\n")[0].trim() : "";
      return task ? `${agent} ${task}` : agent;
    }
    if (typeof a.path === "string" && a.path) return a.path;
    if (typeof a.file_path === "string" && a.file_path) return a.file_path;
    for (const v of Object.values(a)) {
      if (typeof v === "string" && v) {
        const first = v.split("\n")[0].trim();
        if (first) return first;
      }
    }
  }
  return tool;
}

/** 秒 → 人读耗时 (原型 fmtDur): <60s 一位小数或整数, ≥60s 记 m/s */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function getDetails(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" ? (details as Record<string, unknown>) : null;
}

/**
 * 步骤增删行统计: result.details.patch|diff 里数 +/- 行 (跳过 +++/--- 文件头);
 * write 的 details 为 undefined, 按 args.content 行数计新增 (原 ToolCallCard 口径);
 * 都没有则 null (不显示 diff 位)。
 */
export function stepDiffStat(entry: ChatEntry): { add: number; del: number } | null {
  const details = getDetails(entry.result);
  if (details) {
    const text =
      typeof details.patch === "string" && details.patch
        ? details.patch
        : typeof details.diff === "string" && details.diff
          ? details.diff
          : null;
    if (text) {
      let add = 0;
      let del = 0;
      for (const line of text.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) add += 1;
        else if (line.startsWith("-")) del += 1;
      }
      return { add, del };
    }
  }
  if (entry.toolName === "write" && entry.args && typeof entry.args === "object") {
    const content = (entry.args as { content?: unknown }).content;
    if (typeof content === "string") return { add: content.split("\n").length, del: 0 };
  }
  return null;
}

/** 步骤耗时 (秒); startedAt/endedAt 任一缺失 → null (运行中/历史缺时间戳显示空白) */
export function stepDuration(entry: ChatEntry): number | null {
  if (typeof entry.startedAt !== "number" || typeof entry.endedAt !== "number") return null;
  return (entry.endedAt - entry.startedAt) / 1000;
}

export interface StepGroupStats {
  tools: [string, number][]; // 按首次出现顺序的工具分布
  total: number | null; // 组内有效耗时之和 (秒); 全无 → null
  errors: number;
  running: boolean;
}

export function groupStats(entries: ChatEntry[]): StepGroupStats {
  const counts = new Map<string, number>();
  let errors = 0;
  let running = false;
  let total = 0;
  let hasDuration = false;
  for (const entry of entries) {
    const name = entry.toolName ?? "";
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (entry.status === "error") errors += 1;
    if (entry.status === "running") running = true;
    const d = stepDuration(entry);
    if (d !== null) {
      total += d;
      hasDuration = true;
    }
  }
  return { tools: [...counts.entries()], total: hasDuration ? total : null, errors, running };
}

// ---------------------------------------------------------------------------
// 以下四个提取函数自旧 ToolCallCard 原样搬入 (逻辑不改), 供时间线行与检查器详情复用
// ---------------------------------------------------------------------------

/** 从 result.details 提取 subagent 约定字段 (识别 + 联动 + 摘要用)。 */
export function extractSubagentDetails(result: unknown): {
  asyncDir?: string;
  runId?: string;
  agent?: string;
  durationMs?: number;
  costUsd?: number;
} | null {
  const d = getDetails(result);
  if (!d) return null;
  // 识别判据: details 含 asyncDir 或 runId (observability.md: 顶层 async run 的 details.asyncDir)。
  // 字段名按文档宽松取: 缺失给 undefined 不报错
  if (typeof d.asyncDir !== "string" && typeof d.runId !== "string") return null;
  return {
    asyncDir: typeof d.asyncDir === "string" ? d.asyncDir : undefined,
    runId: typeof d.runId === "string" ? d.runId : undefined,
    agent: typeof d.agent === "string" ? d.agent : undefined,
    durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined,
    costUsd:
      typeof d.costUsd === "number"
        ? d.costUsd
        : typeof d.totalCostUsd === "number"
          ? d.totalCostUsd
          : undefined,
  };
}

/** 从 subagent 工具 args 提取 agent 名 (args 可能是 { agent, task } 对象) */
export function extractAgentFromArgs(args: unknown): string | undefined {
  if (args && typeof args === "object") {
    const a = (args as { agent?: unknown }).agent;
    if (typeof a === "string" && a) return a;
  }
  return undefined;
}

/** 从 pi 的 tool result 里提取文本 (result.content[].text) */
export function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as { content?: unknown[] };
    if (Array.isArray(r.content)) {
      const texts = r.content
        .filter(
          (c): c is { type: string; text: string } =>
            typeof c === "object" &&
            c !== null &&
            (c as { type?: string }).type === "text"
        )
        .map((c) => c.text || "");
      if (texts.length) return texts.join("\n");
    }
  }
  return "";
}

/**
 * 从 result.details 取 diff 数据。判定依据是 details 里有无 diff 数据, 不是工具名 ——
 * 第三方工具只要遵循 pi 的 details 约定就自动获得 diff 渲染, 无需在 GUI 侧维护工具名白名单。
 */
export function extractDiff(result: unknown): { patch?: string; diff?: string } | null {
  const d = getDetails(result);
  if (!d) return null;
  if (typeof d.patch === "string" && d.patch) return { patch: d.patch };
  if (typeof d.diff === "string" && d.diff) return { diff: d.diff };
  return null;
}
