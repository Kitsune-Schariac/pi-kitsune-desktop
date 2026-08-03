import { memo, useState } from "react";
import type { ChatEntry } from "../store/session";
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

// diff 行着色: + 绿 - 红 @@ 灰
function DiffView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="mt-2 max-h-64 overflow-auto rounded bg-neutral-50 p-2 text-xs leading-relaxed">
      {lines.map((line, i) => {
        let cls = "text-neutral-400";
        if (line.startsWith("+")) cls = "text-green-600";
        else if (line.startsWith("-")) cls = "text-red-600";
        else if (line.startsWith("@@")) cls = "text-neutral-400";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
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
  const isDiff = entry.toolName === "edit" || entry.toolName === "write";
  const isBash = entry.toolName === "bash";

  return (
    <div className="text-sm">
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
      {/* 展开: 参数 + 结果 (差异化渲染) */}
      {expanded && (
        <div className="mt-2 space-y-2 pl-5">
          {argsStr && (
            <pre className="overflow-x-auto rounded bg-neutral-950/60 p-2 text-xs text-neutral-400">
              {argsStr}
            </pre>
          )}
          {resultText && isDiff && <DiffView text={resultText} />}
          {resultText && isBash && (
            <pre className="max-h-48 overflow-auto rounded bg-neutral-900 p-2 font-mono text-xs text-green-300">
              {resultText}
            </pre>
          )}
          {resultText && !isDiff && !isBash && (
            <pre className="max-h-48 overflow-auto rounded bg-neutral-950/60 p-2 text-xs text-neutral-400">
              {resultText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
