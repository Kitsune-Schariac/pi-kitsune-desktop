import { useState } from "react";
import { Brain, ChevronRight, ChevronDown } from "lucide-react";

// 推理过程折叠行: 默认一行灰色小字, 点击展开完整 thinking
export function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-neutral-500 transition duration-fast ease-out hover:text-neutral-600"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Brain className="h-3 w-3" />
        <span>推理过程</span>
        {!expanded && <span className="text-neutral-300">{text.length} 字</span>}
      </button>
      {expanded && (
        // 左侧竖线 + 浅灰小字: 与正式回复区分层级
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-300 pl-3 text-xs leading-relaxed text-neutral-500">
          {text}
        </div>
      )}
    </div>
  );
}
