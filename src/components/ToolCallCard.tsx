import { memo } from "react";
import type { ChatEntry } from "../store/session";
import { Terminal, Wrench, Loader2, CheckCircle2, XCircle } from "lucide-react";

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
  const Icon = toolIcons[entry.toolName || ""] || Wrench;
  const argsStr = entry.args
    ? typeof entry.args === "string"
      ? entry.args
      : JSON.stringify(entry.args, null, 2)
    : "";
  const resultText = entry.result ? extractResultText(entry.result) : "";
  const isDiff = entry.toolName === "edit" || entry.toolName === "write";
  const isBash = entry.toolName === "bash";

  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm">
      <div className="flex items-center gap-2 text-neutral-700">
        <Icon className="h-4 w-4 text-neutral-400" />
        <span className="font-medium">{entry.toolName}</span>
        {entry.status === "running" && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />
        )}
        {entry.status === "done" && (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        )}
        {entry.status === "error" && (
          <XCircle className="h-3.5 w-3.5 text-red-500" />
        )}
      </div>
      {argsStr && (
        <pre className="mt-2 overflow-x-auto rounded bg-neutral-950/60 p-2 text-xs text-neutral-400">
          {argsStr}
        </pre>
      )}
      {/* 工具结果差异化渲染 */}
      {resultText && isDiff && <DiffView text={resultText} />}
      {resultText && isBash && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-neutral-900 p-2 font-mono text-xs text-green-300">
          {resultText}
        </pre>
      )}
      {resultText && !isDiff && !isBash && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-neutral-950/60 p-2 text-xs text-neutral-400">
          {resultText}
        </pre>
      )}
    </div>
  );
});