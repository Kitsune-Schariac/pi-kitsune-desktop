import { useState } from "react";
import { Brain, ChevronRight, ChevronDown } from "lucide-react";

// 推理过程折叠面板: 默认折叠避免干扰, 展开查看完整 thinking
export function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  return (
    <div className="mb-2 rounded-lg border border-neutral-800/60 bg-neutral-900/40">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-neutral-500 transition hover:text-neutral-400"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Brain className="h-3 w-3" />
        <span>推理过程</span>
        <span className="text-neutral-700">{text.length} 字</span>
      </button>
      {expanded && (
        <div className="whitespace-pre-wrap border-t border-neutral-800/60 px-3 py-2 text-xs leading-relaxed text-neutral-500">
          {text}
        </div>
      )}
    </div>
  );
}