// 舰队 stream 源推导: 从主会话 entries 推导前台同步子代理条目。
// 纯函数, 不碰文件/不加 Rust command —— session store 已把 toolCall 与 toolResult
// 配对成 ChatEntry(kind="tool", status=running|done|error), 这里只过滤 subagent 族 +
// 提取摘要/状态。识别集合精确匹配, 宁漏勿误: 误收普通工具会把 bash/read 拉进舰队,
// 噪音比缺失更伤 (design §5 关键决策)。
import type { ChatEntry } from "../store/session";

// 前台同步子代理工具族: 主会话用这些工具派发子代理。
// - subagent / subagent_wait: pi-subagents 前台同步 run
// - trellis_subagent: Trellis dispatch (派 trellis-implement/check 的方式)
// 三者都不产生 status.json (PRD 背景 1), 只能从对话流推导。未知工具不收
export const SUBAGENT_STREAM_TOOLS = new Set([
  "subagent",
  "subagent_wait",
  "trellis_subagent",
]);

export interface StreamEntry {
  key: string; // `stream:<toolCallId>`, 唯一
  agent: string; // 取自 args.agent/agent_name, 缺失用 toolName
  state: "running" | "completed" | "failed" | "unknown";
  startedAt: number; // epoch ms, 0 if missing (耗时显示 —)
  endedAt?: number;
  toolCallId: string;
  prompt: string; // 一行摘要: task/prompt 首行截断
  resultSummary?: string; // completed/failed 时 result 文本首段截断
  // 下钻抽屉用全文 (原地展开, 不弹层)
  fullPrompt: string; // task/prompt 全文, 缺失回退 args JSON
  fullResult?: string; // result 完整文本
}

// 从 args 提取 agent 名 (args 可能是 {agent, task} 或 {agent_name, ...})
function extractAgent(args: unknown, fallback: string): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.agent === "string" && a.agent) return a.agent;
    if (typeof a.agent_name === "string" && a.agent_name) return a.agent_name;
  }
  return fallback;
}

// 从 args 提取 prompt 摘要 (task/prompt/description 首行 60 字符)
function extractPromptSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const raw =
    (typeof a.task === "string" && a.task) ||
    (typeof a.prompt === "string" && a.prompt) ||
    (typeof a.description === "string" && a.description) ||
    "";
  if (!raw) return "";
  const firstLine = raw.split("\n")[0].trim();
  return firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
}

// 从 args 提取完整 prompt (task/prompt 全文, 缺失回退 JSON.stringify 便于抽屉查看)
function extractFullPrompt(args: unknown): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  if (typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.task === "string" && a.task) return a.task;
    if (typeof a.prompt === "string" && a.prompt) return a.prompt;
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return "";
    }
  }
  return "";
}

// 从 result 提取文本 (对齐 ToolCallCard.extractResultText: content[].text 拼接 / string 直用)。
// 实时路径 result 可能是 partialResult 累计文本; 历史路径 result = {content, details}
function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as { content?: unknown[] };
    if (Array.isArray(r.content)) {
      const texts = r.content
        .filter(
          (c): c is { type: string; text: string } =>
            typeof c === "object" &&
            c !== null &&
            (c as { type?: string }).type === "text",
        )
        .map((c) => c.text || "");
      if (texts.length) return texts.join("\n");
    }
    // 无 content 数组 (实时 partialResult 等裸结构) → 兜底 stringify
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return "";
    }
  }
  return "";
}

// result 文本首段 120 字符 (列表单行摘要用)
function summarizeResult(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const firstPara = t.split("\n")[0].trim();
  return firstPara.length > 120 ? firstPara.slice(0, 120) + "…" : firstPara;
}

/**
 * 从主会话 entries 推导 stream 条目 (前台同步子代理)。
 * 输入: session store 的当前会话 entries (实时流 + 回放共用 ChatEntry 结构)。
 * 配对已在 session store 完成 (toolCall/toolResult 合并成 kind="tool" entry),
 * 这里只过滤 subagent 族 + 提取摘要/状态。无配对 result → running (实时);
 * 历史回放 entry 全是 done/error (mapHistoryEntries 已配对回放)。
 */
export function deriveStreamEntries(entries: ChatEntry[]): StreamEntry[] {
  const out: StreamEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "tool" || !e.toolName) continue;
    if (!SUBAGENT_STREAM_TOOLS.has(e.toolName)) continue;
    const state: StreamEntry["state"] =
      e.status === "running"
        ? "running"
        : e.status === "done"
          ? "completed"
          : e.status === "error"
            ? "failed"
            : "unknown";
    // running 时不取 result 文本 (显示 prompt 摘要 + 进度交给消息流卡片);
    // completed/failed 取 resultSummary 供列表 + fullResult 供抽屉
    const resultText = state !== "running" ? extractResultText(e.result) : "";
    out.push({
      key: `stream:${e.toolCallId ?? e.id}`,
      agent: extractAgent(e.args, e.toolName),
      state,
      startedAt: e.startedAt ?? 0,
      endedAt: e.endedAt,
      toolCallId: e.toolCallId ?? e.id,
      prompt: extractPromptSummary(e.args),
      resultSummary: state !== "running" ? summarizeResult(resultText) : undefined,
      fullPrompt: extractFullPrompt(e.args),
      fullResult: state !== "running" ? resultText : undefined,
    });
  }
  return out;
}