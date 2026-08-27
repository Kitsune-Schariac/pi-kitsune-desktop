import { memo, useEffect, useRef, useState } from "react";
import type { ChatEntry } from "../store/session";
import { useSessionStore } from "../store/session";
import { useFleetStore } from "../store/fleet";
import { DiffView, PlainDiffView } from "./DiffView";
import {
  Terminal, Wrench, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown,
  Bot, Radar,
} from "lucide-react";

const toolIcons: Record<string, typeof Terminal> = {
  bash: Terminal,
  edit: Wrench,
  write: Wrench,
  read: Wrench,
  // subagent 族用 Bot 图标 (R1 特判: 工具名识别)
  subagent: Bot,
  subagent_wait: Bot,
};

// subagent 工具族: 发起子 agent 运行的工具 (PRD R1: subagent 及同族)。
// 识别双重依据: 工具名命中 OR result.details 含 subagent 约定字段, 两者都不满足才回退普通卡片
const SUBAGENT_TOOLS = new Set(["subagent", "subagent_wait"]);

// 从 result.details 提取 subagent 约定字段 (识别 + 联动 + 摘要用)。
// 识别判据: details 含 asyncDir 或 runId (observability.md: 顶层 async run 的 details.asyncDir)。
// 字段名按文档推断, 宽松取 (本任务立项时无 subagent 工具结果 details 真实样本, 缺失给 undefined 不报错)
function extractSubagentDetails(result: unknown): {
  asyncDir?: string;
  runId?: string;
  agent?: string;
  durationMs?: number;
  costUsd?: number;
} | null {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
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

// 从 subagent 工具 args 提取 agent 名 (args 可能是 { agent, task } 对象)
function extractAgentFromArgs(args: unknown): string | undefined {
  if (args && typeof args === "object") {
    const a = (args as { agent?: unknown }).agent;
    if (typeof a === "string" && a) return a;
  }
  return undefined;
}

// 从 pi 的 tool result 里提取文本 (result.content[].text)
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
            (c as { type?: string }).type === "text"
        )
        .map((c) => c.text || "");
      if (texts.length) return texts.join("\n");
    }
  }
  return "";
}

// 从 result.details 取 diff 数据。判定依据是 details 里有无 diff 数据, 不是工具名 ——
// 第三方工具只要遵循 pi 的 details 约定就自动获得 diff 渲染, 无需在 GUI 侧维护工具名白名单;
// write 的 details 为 undefined, 自动落"无 diff"分支, 断裂三随之消失
function extractDiff(result: unknown): { patch?: string; diff?: string } | null {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const d = details as { patch?: unknown; diff?: unknown };
  if (typeof d.patch === "string" && d.patch) return { patch: d.patch };
  if (typeof d.diff === "string" && d.diff) return { diff: d.diff };
  return null;
}

export const ToolCallCard = memo(function ToolCallCard({ entry }: { entry: ChatEntry }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = toolIcons[entry.toolName || ""] || Wrench;
  const argsStr = entry.args
    ? typeof entry.args === "string"
      ? entry.args
      : JSON.stringify(entry.args, null, 2)
    : "";
  // 折叠时的"大概": 取参数第一行 (bash 命令 / 文件路径等)
  const summary = argsStr.split("\n")[0].trim();
  const resultText = entry.result ? extractResultText(entry.result) : "";
  const diff = entry.result ? extractDiff(entry.result) : null;
  const isBash = entry.toolName === "bash";

  // R1 subagent 特判: 工具名 OR details 字段双重识别, 任一满足即专用呈现, 都不满足回退普通卡片
  const isSubagent = SUBAGENT_TOOLS.has(entry.toolName || "");
  const subagentDetails = entry.result ? extractSubagentDetails(entry.result) : null;
  const showSubagent = isSubagent || !!subagentDetails;
  const agentName =
    extractAgentFromArgs(entry.args) || subagentDetails?.agent || entry.toolName || "";
  // 运行中进度尾行: partialResult 已由 session.ts 管道累计进 result, 取文本最后一行做实时预览
  const progressTail = resultText ? (resultText.split("\n").pop()?.trim() || "") : "";

  // 联动按钮 → fleet store 递增 panelRequest → App effect 开舰队面板 (基础联动, 不精确定位 run)
  // 用 getState() 直调而非订阅: ToolCallCard 是消息流高频组件, 订阅 panelRequest 会让所有
  // 卡片随每次联动点击重渲染 (component-guidelines: 高频路径不订阅 store), 此处只需触发不需读值

  // cwd 用于 diff 路径相对化: selector 粒度取当前会话 cwd (会话级常量, 不随消息流变化)
  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.cwd : undefined;
  });

  // 进度尾行自动滚底 (运行中 partialResult 追加, 等宽区始终显示最新)
  const progressRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (progressRef.current) progressRef.current.scrollTop = progressRef.current.scrollHeight;
  }, [progressTail]);

  return (
    // 结构标记提权: 2px primary 左边条 + sunken 底 + subtle 边框, 让工具调用在消息流里更易被扫到。
    // 底色走 --overlay-alpha: 纯色皮肤下实色撑层次, 背景图皮肤下半透明, 不糊掉背景。
    // 用内联 style 写边框避免 tailwind border-color longhand 与 shorthand 任意值优先级不确定。
    <div
      className="rounded-lg p-2 text-sm"
      style={{
        background: "rgb(var(--surface-sunken) / var(--overlay-alpha))",
        border: "1px solid rgb(var(--border-subtle))",
        borderLeft: "2px solid rgb(var(--primary-500))",
      }}
    >
      {/* 折叠行: 工具名 + 状态 + 参数摘要 / subagent 进度尾行 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left text-neutral-600 transition hover:text-neutral-900"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <span className="shrink-0 font-medium">{showSubagent ? agentName : entry.toolName}</span>
        {entry.status === "running" &&
          (showSubagent ? (
            // subagent 运行中: primary 呼吸灯 (animate-pulse 2s), 替代通用 spinner, 表达"子 agent 在跑"
            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-[rgb(var(--primary-500))] animate-pulse" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" />
          ))}
        {entry.status === "done" && (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
        )}
        {entry.status === "error" && (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
        )}
        {/* 摘要区: subagent 运行中显示进度尾行, done 显示耗时/cost; 普通工具显示 args 首行 */}
        {showSubagent && entry.status === "running" && progressTail && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-400" title={progressTail}>
            {progressTail}
          </span>
        )}
        {showSubagent && entry.status === "done" && subagentDetails && (
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
            {subagentDetails.durationMs != null && (
              <span className="tabular-nums">{Math.floor(subagentDetails.durationMs / 1000)}s</span>
            )}
            {subagentDetails.costUsd != null && (
              <span className="tabular-nums"> · ${subagentDetails.costUsd.toFixed(2)}</span>
            )}
            {subagentDetails.runId && (
              <span className="ml-1 font-mono text-neutral-400">{subagentDetails.runId.slice(0, 8)}</span>
            )}
          </span>
        )}
        {!showSubagent && summary && (
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-400">{summary}</span>
        )}
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        )}
      </button>
      {/* 展开: 参数 + 结果 (差异化渲染)
          底色走 --code-bg 而非 bg-neutral-950: 中性色阶在暗色方向整组反转,
          neutral-950 会翻成白色, 让"深底浅字"变成"浅底灰字" */}
      {expanded && (
        <div className="mt-2 space-y-2 pl-5">
          {/* R1 subagent 专用区: 运行中进度尾行等宽滚动区 (自动滚底) + done 联动按钮 */}
          {showSubagent && entry.status === "running" && resultText && (
            <pre
              ref={progressRef}
              className="max-h-40 overflow-auto rounded bg-[rgb(var(--code-bg)/var(--code-alpha))] p-2 font-mono text-xs text-[rgb(var(--term-text))]"
            >
              {resultText}
            </pre>
          )}
          {showSubagent && entry.status === "done" && (
            <div className="flex items-center gap-1.5 text-xs">
              <Radar className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--primary-500))]" />
              <button
                onClick={() => useFleetStore.getState().requestOpenPanel()}
                className="text-[rgb(var(--primary-600))] transition hover:text-[rgb(var(--primary-700))]"
                title="打开舰队面板查看此子 agent"
              >
                在舰队中查看
              </button>
            </div>
          )}
          {/* 保留普通工具的参数展示 (subagent 也不丢信息: args 可展开查看) */}
          {argsStr && (
            <pre className="overflow-x-auto rounded bg-[rgb(var(--code-bg)/var(--code-alpha))] p-2 text-xs text-neutral-700">
              {argsStr}
            </pre>
          )}
          {/* diff 渲染: details.patch → unified patch (双列行号 + 语法高亮);
              details.patch 缺失 → details.diff 朴素着色回退 (无行号, 保证不白屏);
              两者皆无 → 普通文本 (write 等无 details 的工具自动落此分支, 不再空转) */}
          {diff?.patch && <DiffView patch={diff.patch} cwd={cwd} />}
          {!diff?.patch && diff?.diff && <PlainDiffView text={diff.diff} />}
          {resultText && !diff && isBash && (
            <pre className="max-h-48 overflow-auto rounded bg-[rgb(var(--code-bg)/var(--code-alpha))] p-2 font-mono text-xs text-[rgb(var(--term-text))]">
              {resultText}
            </pre>
          )}
          {resultText && !diff && !isBash && (
            <pre className="max-h-48 overflow-auto rounded bg-[rgb(var(--code-bg)/var(--code-alpha))] p-2 text-xs text-neutral-700">
              {resultText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
