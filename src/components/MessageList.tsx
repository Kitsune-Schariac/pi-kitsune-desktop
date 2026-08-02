import { useEffect, useRef } from "react";
import { useSessionStore } from "../store/session";
import { ToolCallCard } from "./ToolCallCard";
import { MessageItem } from "./MessageItem";

export function MessageList() {
  const entries = useSessionStore((s) => s.entries);
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // 是否自动跟随滚动: 用户主动上滑查看历史时暂停, 回到底部后恢复
  const autoScrollRef = useRef(true);
  const prevLenRef = useRef(0);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    // 距底部 < 80px 视为"在底部", 允许自动跟随
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    autoScrollRef.current = atBottom;
  };

  // entries 变化时滚动: 新消息强制跟随, 流式 delta 只在用户在底部时跟随
  useEffect(() => {
    const newLen = entries.length;
    const isNewMessage = newLen > prevLenRef.current;
    if (isNewMessage) autoScrollRef.current = true;
    prevLenRef.current = newLen;

    if (autoScrollRef.current) {
      // 新消息平滑滚动, 流式 delta 瞬间跳 (避免 smooth 动画堆积卡顿)
      endRef.current?.scrollIntoView({ behavior: isNewMessage ? "smooth" : "auto" });
    }
  }, [entries]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-6 py-4"
    >
      <div className="mx-auto max-w-3xl space-y-4">
        {entries.length === 0 && (
          <div className="py-20 text-center text-neutral-600">
            输入消息开始对话
          </div>
        )}
        {entries.map((e) =>
          e.kind === "message" ? (
            <MessageItem key={e.id} entry={e} />
          ) : (
            <ToolCallCard key={e.id} entry={e} />
          )
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}