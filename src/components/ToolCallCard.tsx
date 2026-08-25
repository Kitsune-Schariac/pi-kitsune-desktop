import { memo, useState } from "react";
import type { ChatEntry } from "../store/session";
import { useSessionStore } from "../store/session";
import { DiffView, PlainDiffView } from "./DiffView";
import {
  Terminal, Wrench, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown,
} from "lucide-react";

const toolIcons: Record<string, typeof Terminal> = {
  bash: Terminal,
  edit: Wrench,
  write: Wrench,
  read: Wrench,
};

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
  // cwd 用于 diff 路径相对化: selector 粒度取当前会话 cwd (会话级常量, 不随消息流变化)
  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.cwd : undefined;
  });

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
      {/* 折叠行: 工具名 + 状态 + 参数摘要 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left text-neutral-600 transition hover:text-neutral-900"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <span className="shrink-0 font-medium">{entry.toolName}</span>
        {entry.status === "running" && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" />
        )}
        {entry.status === "done" && (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
        )}
        {entry.status === "error" && (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
        )}
        {summary && (
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
