import { useEffect, useRef } from "react";
import { useSessionStore } from "../store/session";
import { ToolCallCard } from "./ToolCallCard";
import { MessageItem } from "./MessageItem";
import { NotificationItem } from "./NotificationItem";

export function MessageList({ inputBarH = 0 }: { inputBarH?: number }) {
  const entries = useSessionStore((s) => {
  const a = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
  return a?.entries ?? [];
});
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
      className="flex-1 overflow-y-auto pt-4"
      // 底部 padding = 输入卡高 + bottom-4(16px) + 间隔 24px: 滚动到底消息停在卡片上方间隔处,
      // 滚动过程中消息可平滑滑入卡片后方 (卡片半透明可见), 不会被提前截断
      style={{ paddingBottom: inputBarH + 40 }}
    >
      {/* px-6 放内层: 保证 65% 宽度与悬浮输入卡一致 (外层 padding 会使百分比相对内容区, 差 48px) */}
      <div className="mx-auto max-w-[65%] space-y-4 px-6">
        {entries.length === 0 && (
          <div className="py-20 text-center text-neutral-400">
            输入消息开始对话
          </div>
        )}
        {entries.map((e) =>
          e.kind === "message" ? (
            <MessageItem key={e.id} entry={e} />
          ) : e.kind === "notification" ? (
            <NotificationItem key={e.id} entry={e} />
          ) : (
            <ToolCallCard key={e.id} entry={e} />
          )
        )}
      </div>
      {/* 滚动锚点放 space-y 容器外: 避免被 space-y-4 加 margin, 否则最后消息与输入卡之间总有 16px 空隙 */}
      <div ref={endRef} />
    </div>
  );
}