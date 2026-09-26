import { memo, useState } from "react";
import { AlertTriangle, ChevronDown, Info, Sparkle, XCircle } from "lucide-react";
import type { ChatEntry } from "../../store/session";
import type { TimelineItem, Turn } from "../../lib/timeline";
import { Markdown } from "../Markdown";
import { StepGroup } from "./StepGroup";

interface TurnViewProps {
  turn: Turn;
  /** 会话流式中且这是最后一轮: 工坊给脊线加流光 */
  live: boolean;
  /** 正在流式生成的 assistant entry id: 只有它末尾显示光标 */
  streamingReplyId: string | null;
  selectedId: string | null;
  /** 「在时间线定位」信号 (递增): 传给组以展开折叠中的目标 */
  revealSeq: number;
}

/**
 * 单轮渲染: prompt / reply / steps / notice 按 buildTimeline 给的顺序排布, 不重排。
 * memo 自定义比较逐项引用相等 —— 流式 delta 只改最后一条 assistant entry 的引用,
 * 未变化的轮全部跳过重渲染 (只允许最后一轮重渲染)。
 */
export const TurnView = memo(function TurnView({
  turn,
  live,
  streamingReplyId,
  selectedId,
  revealSeq,
}: TurnViewProps) {
  return (
    <article className={`tl-turn${live ? " live" : ""}`}>
      {turn.items.map((item) => {
        if (item.kind === "prompt") {
          return <PromptView key={`p:${item.entry.id}`} entry={item.entry} />;
        }
        if (item.kind === "reply") {
          return (
            <ReplyView
              key={`r:${item.entry.id}`}
              entry={item.entry}
              cursor={live && item.entry.id === streamingReplyId}
            />
          );
        }
        if (item.kind === "steps") {
          return (
            <StepGroup
              key={item.id}
              entries={item.entries}
              selectedId={selectedId}
              revealSeq={revealSeq}
            />
          );
        }
        return <NoticeRow key={`n:${item.entry.id}`} entry={item.entry} />;
      })}
    </article>
  );
}, sameTurnProps);

function sameItem(a: TimelineItem, b: TimelineItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "steps" && b.kind === "steps") {
    if (a.id !== b.id || a.entries.length !== b.entries.length) return false;
    for (let i = 0; i < a.entries.length; i++) {
      if (a.entries[i] !== b.entries[i]) return false;
    }
    return true;
  }
  if (a.kind === "steps" || b.kind === "steps") return false;
  return a.entry === b.entry;
}

function sameTurnProps(a: TurnViewProps, b: TurnViewProps): boolean {
  if (a.live !== b.live) return false;
  if (a.streamingReplyId !== b.streamingReplyId) return false;
  if (a.selectedId !== b.selectedId || a.revealSeq !== b.revealSeq) return false;
  if (a.turn.id !== b.turn.id || a.turn.items.length !== b.turn.items.length) return false;
  return a.turn.items.every((item, i) => sameItem(item, b.turn.items[i]));
}

/** 用户提问: 工坊 = 章节标题 (上方「你」元信息); 舞台 = 右对齐 accent 气泡 */
const PromptView = memo(function PromptView({ entry }: { entry: ChatEntry }) {
  return (
    <header className="tl-prompt">
      {/* ChatEntry 没有时间戳, 元信息只写「你」, 不编造时间 (原型的"你 · 14:02"是示意数据) */}
      <span className="tl-prompt-meta">你</span>
      <p className="tl-prompt-text">{entry.text}</p>
    </header>
  );
});

/** AI 回复: 推理折叠 + Markdown 正文; 流式中末尾由 .tl-streaming 的伪元素跟一个光标 */
const ReplyView = memo(function ReplyView({ entry, cursor }: { entry: ChatEntry; cursor: boolean }) {
  return (
    <div className="tl-reply-wrap">
      {entry.thinking ? <ThinkingView text={entry.thinking} /> : null}
      <div className={`tl-reply${cursor ? " tl-streaming" : ""}`}>
        {entry.text ? <Markdown text={entry.text} /> : <span className="tl-dots">…</span>}
        {/* 空回复时正文还没有块级元素, 伪元素挂不上去, 光标直接内联在省略号后 */}
        {cursor && !entry.text && <span className="tl-caret" />}
      </div>
    </div>
  );
});

/** 推理过程: 「推理 · N 字」折叠行 (默认收起), 展开为竖线包裹的灰字 */
const ThinkingView = memo(function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tl-think${open ? " open" : ""}`}>
      <button type="button" className="tl-think-head" onClick={() => setOpen((v) => !v)}>
        <Sparkle className="h-3 w-3" />
        <span>推理</span>
        <span className="tl-think-len">{text.length.toLocaleString()} 字</span>
        <ChevronDown className="tl-chev h-3 w-3" />
      </button>
      {open && <div className="tl-think-body">{text}</div>}
    </div>
  );
});

const NOTICE_ICONS = { info: Info, warning: AlertTriangle, error: XCircle } as const;

/** 会话内通知条目 (原 NotificationItem 的重写): 三色左边框 + 类型图标, 不自动消失 */
const NoticeRow = memo(function NoticeRow({ entry }: { entry: ChatEntry }) {
  const type = entry.notifyType ?? "info";
  const Icon = NOTICE_ICONS[type];
  return (
    <div className={`tl-notice ${type}`}>
      <Icon className="mt-[3px] h-3 w-3 shrink-0" />
      <span>{entry.text}</span>
    </div>
  );
});
