import type { ChatEntry } from "../store/session";
import { Terminal, Wrench, Loader2, CheckCircle2, XCircle } from "lucide-react";

// 工具图标映射: 只对 bash 特化, 其余用通用扳手
const toolIcons: Record<string, typeof Terminal> = {
  bash: Terminal,
  edit: Wrench,
  write: Wrench,
  read: Wrench,
};

export function ToolCallCard({ entry }: { entry: ChatEntry }) {
  const Icon = toolIcons[entry.toolName || ""] || Wrench;
  const argsStr = entry.args
    ? typeof entry.args === "string"
      ? entry.args
      : JSON.stringify(entry.args, null, 2)
    : "";

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3 text-sm">
      <div className="flex items-center gap-2 text-neutral-300">
        <Icon className="h-4 w-4 text-neutral-500" />
        <span className="font-medium">{entry.toolName}</span>
        {entry.status === "running" && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-500" />
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
      {entry.result != null && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-neutral-950/60 p-2 text-xs text-neutral-400">
          {typeof entry.result === "string"
            ? entry.result
            : JSON.stringify(entry.result, null, 2)}
        </pre>
      )}
    </div>
  );
}