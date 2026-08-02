import { useEffect, useRef } from "react";
import { useSessionStore } from "../store/session";
import { ToolCallCard } from "./ToolCallCard";
import { User, Bot } from "lucide-react";

export function MessageList() {
  const entries = useSessionStore((s) => s.entries);
  const endRef = useRef<HTMLDivElement>(null);

  // 新内容到达时自动滚到底部
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="mx-auto max-w-3xl space-y-4">
        {entries.length === 0 && (
          <div className="py-20 text-center text-neutral-600">
            输入消息开始对话
          </div>
        )}
        {entries.map((e) =>
          e.kind === "message" ? (
            <div
              key={e.id}
              className={`flex gap-3 ${
                e.role === "user" ? "flex-row-reverse" : ""
              }`}
            >
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  e.role === "user"
                    ? "bg-blue-500/10 text-blue-400"
                    : "bg-orange-500/10 text-orange-400"
                }`}
              >
                {e.role === "user" ? (
                  <User className="h-4 w-4" />
                ) : (
                  <Bot className="h-4 w-4" />
                )}
              </div>
              <div
                className={`min-w-0 max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  e.role === "user"
                    ? "bg-blue-500/10 text-neutral-100"
                    : "bg-neutral-900 text-neutral-200"
                }`}
              >
                {e.text ||
                  (e.role === "assistant" && (
                    <span className="animate-pulse text-neutral-600">…</span>
                  ))}
              </div>
            </div>
          ) : (
            <ToolCallCard key={e.id} entry={e} />
          )
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}