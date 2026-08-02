import { memo } from "react";
import type { ChatEntry } from "../store/session";
import { ThinkingBlock } from "./ThinkingBlock";
import { User, Bot } from "lucide-react";

// 单条消息渲染: memo 浅比较 entry。streaming 时 store 的 map 只对当前条目建新对象,
// 其余条目引用不变 → memo 跳过 re-render, 大幅减少高频流式更新下的渲染开销
export const MessageItem = memo(function MessageItem({ entry }: { entry: ChatEntry }) {
  return (
    <div
      className={`flex gap-3 ${
        entry.role === "user" ? "flex-row-reverse" : ""
      }`}
    >
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          entry.role === "user"
            ? "bg-blue-100 text-blue-600"
            : "bg-orange-100 text-orange-600"
        }`}
      >
        {entry.role === "user" ? (
          <User className="h-4 w-4" />
        ) : (
          <Bot className="h-4 w-4" />
        )}
      </div>
      <div
        className={`min-w-0 max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          entry.role === "user"
            ? "bg-blue-50 text-neutral-800"
            : "bg-neutral-100 text-neutral-800"
        }`}
      >
        {entry.thinking && <ThinkingBlock text={entry.thinking} />}
        {entry.text ||
          (entry.role === "assistant" && (
            <span className="animate-pulse text-neutral-400">…</span>
          ))}
      </div>
    </div>
  );
});