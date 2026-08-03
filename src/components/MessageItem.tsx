import { memo } from "react";
import type { ChatEntry } from "../store/session";
import { ThinkingBlock } from "./ThinkingBlock";
import { Markdown } from "./Markdown";

// 单条消息渲染 (无头像无气泡): 内容直接铺开
// user 靠右 + 蓝色文字, assistant 靠左占满
// memo 浅比较 entry: streaming 时只有当前条目重建对象 → 其余跳过 re-render
export const MessageItem = memo(function MessageItem({ entry }: { entry: ChatEntry }) {
  return (
    <div className={entry.role === "user" ? "flex justify-end" : "flex justify-start"}>
      <div
        className={`min-w-0 text-sm leading-relaxed ${
          entry.role === "user"
            ? "max-w-[85%] text-right text-blue-700"
            : "w-full text-neutral-800"
        }`}
      >
        {entry.thinking && <ThinkingBlock text={entry.thinking} />}
        {entry.text ? (
          <Markdown text={entry.text} />
        ) : entry.role === "assistant" ? (
          <span className="animate-pulse text-neutral-400">…</span>
        ) : null}
      </div>
    </div>
  );
});
