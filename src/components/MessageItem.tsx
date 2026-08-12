import { memo } from "react";
import type { ChatEntry } from "../store/session";
import { ThinkingBlock } from "./ThinkingBlock";
import { Markdown } from "./Markdown";
import { useThemeStore } from "../store/theme";

// 单条消息渲染: 无头像; 气泡开关关 = 内容直接铺开 (user 靠右 + 蓝字, assistant 靠左占满),
// 开 = 毛玻璃气泡块兜可读性 (assistant 收窄 max-w-[90%] 成规整块, user 保持靠右)
// memo 浅比较 entry: streaming 时只有当前条目重建对象 → 其余跳过 re-render
export const MessageItem = memo(function MessageItem({ entry }: { entry: ChatEntry }) {
  const bubbleOn = useThemeStore((s) => s.bubbleEnabled);
  const isUser = entry.role === "user";
  const content = (
    <>
      {entry.thinking && <ThinkingBlock text={entry.thinking} />}
      {entry.text ? (
        <Markdown text={entry.text} />
      ) : entry.role === "assistant" ? (
        <span className="animate-pulse text-neutral-400">…</span>
      ) : null}
    </>
  );
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      {bubbleOn ? (
        // 气泡模式: 气泡底色/不透明率由 --bubble-bg / --bubble-opacity 驱动 (见 index.css .bubble)
        <div
          className={`bubble min-w-0 text-sm leading-relaxed ${
            isUser
              ? "max-w-[85%] text-[rgb(var(--text-on-bubble))]"
              : "max-w-[90%] text-[rgb(var(--text-on-bubble))]"
          }`}
        >
          {content}
        </div>
      ) : (
        <div
          className={`min-w-0 text-sm leading-relaxed ${
            isUser
              ? "max-w-[85%] text-[rgb(var(--text-user))]"
              : "w-full text-neutral-800"
          }`}
        >
          {content}
        </div>
      )}
    </div>
  );
});
