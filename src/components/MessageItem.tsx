import { memo } from "react";
import type { ChatEntry } from "../store/session";
import { ThinkingBlock } from "./ThinkingBlock";
import { Markdown } from "./Markdown";

// 单条消息渲染: assistant 全宽平铺, user 右对齐浅底块。
// 气泡三件套已删除 (D2), 过渡期先保留简版块, 阶段 3 由时间线 PromptView / ReplyView 整体替换。
// memo 浅比较 entry: streaming 时只有当前条目重建对象 → 其余跳过 re-render
export const MessageItem = memo(function MessageItem({ entry }: { entry: ChatEntry }) {
  const isUser = entry.role === "user";
  const content = (
    <>
      {entry.thinking && <ThinkingBlock text={entry.thinking} />}
      {entry.text ? (
        <Markdown text={entry.text} />
      ) : entry.role === "assistant" ? (
        <span className="animate-pulse text-fg-3">…</span>
      ) : null}
    </>
  );
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      {isUser ? (
        <div className="min-w-0 max-w-[85%] rounded-lg border border-[var(--line)] bg-[var(--well)] px-3 py-2 text-body leading-relaxed text-fg">
          {content}
        </div>
      ) : (
        <div className="min-w-0 w-full text-body leading-relaxed text-fg">{content}</div>
      )}
    </div>
  );
});
