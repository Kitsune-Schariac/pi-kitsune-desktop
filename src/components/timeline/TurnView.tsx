import { memo, useState } from "react";
import { AlertTriangle, ChevronDown, Info, Sparkle, XCircle } from "lucide-react";
import type { ChatEntry } from "../../store/session";
import type { TimelineItem, Turn } from "../../lib/timeline";
import { Markdown } from "../Markdown";
import { StepGroup } from "./StepGroup";
import { CopyButton } from "../ui";

interface TurnViewProps {
  turn: Turn;
  /** 会话流式中且这是最后一轮: AI 头像加一圈运行光晕 */
  live: boolean;
  /** 正在流式生成的 assistant entry id: 只有它末尾显示光标 */
  streamingReplyId: string | null;
  selectedId: string | null;
  /** 「在时间线定位」信号 (递增): 传给组以展开折叠中的目标 */
  revealSeq: number;
  /** 覆盖步骤点击 (缺省走全局 ui.openStep); 舰队子会话传入, 由面板就地展开详情 */
  onStepClick?: (entry: ChatEntry) => void;
}

/**
 * 单轮渲染 (对话形式): 用户提问 = 右侧气泡; 其后的回复 / 步骤卡片 / 推理 / 通知
 * 按 buildTimeline 给的原顺序收进一个 AI 块 (左侧头像只出现一次), 不重排。
 * 首个提问之前的条目 (head 轮: 欢迎语 / 通知) 没有提问, 直接是一个 AI 块。
 * memo 自定义比较逐项引用相等 —— 流式 delta 只改最后一条 assistant entry 的引用,
 * 未变化的轮全部跳过重渲染 (只允许最后一轮重渲染)。
 */
export const TurnView = memo(function TurnView({
  turn,
  live,
  streamingReplyId,
  selectedId,
  revealSeq,
  onStepClick,
}: TurnViewProps) {
  const prompt = turn.items[0]?.kind === "prompt" ? turn.items[0] : null;
  const rest = prompt ? turn.items.slice(1) : turn.items;
  return (
    <article className="chat-turn">
      {prompt && <PromptView entry={prompt.entry} />}
      {rest.length > 0 && (
        <div className="msg-ai">
          <div className={`ai-avatar${live ? " live" : ""}`} aria-hidden>
            π
          </div>
          <div className="ai-body">
            {rest.map((item) => {
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
                    onStepClick={onStepClick}
                  />
                );
              }
              if (item.kind === "notice") {
                return <NoticeRow key={`n:${item.entry.id}`} entry={item.entry} />;
              }
              // 同一轮里不会再出现 prompt (每条用户消息开新轮); 保险起见按气泡渲染
              return <PromptView key={`p:${item.entry.id}`} entry={item.entry} />;
            })}
          </div>
        </div>
      )}
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
  if (a.onStepClick !== b.onStepClick) return false;
  if (a.turn.id !== b.turn.id || a.turn.items.length !== b.turn.items.length) return false;
  return a.turn.items.every((item, i) => sameItem(item, b.turn.items[i]));
}

/** 用户提问: 右侧气泡, hover 时下方出复制钮 */
const PromptView = memo(function PromptView({ entry }: { entry: ChatEntry }) {
  return (
    <div className="msg-user">
      <p className="bubble">{entry.text}</p>
      <div className="msg-actions">
        <CopyButton text={entry.text ?? ""} title="复制提问" className="chat-copy" />
      </div>
    </div>
  );
});

/** AI 回复: 推理折叠 + Markdown 正文; 流式中末尾由 .streaming 的伪元素跟一个光标 */
const ReplyView = memo(function ReplyView({ entry, cursor }: { entry: ChatEntry; cursor: boolean }) {
  return (
    <div className="ai-reply-wrap">
      {entry.thinking ? <ThinkingView text={entry.thinking} /> : null}
      <div className={`ai-reply${cursor ? " streaming" : ""}${entry.thinking ? " mt-3" : ""}`}>
        {entry.text ? <Markdown text={entry.text} /> : <span className="ai-dots">…</span>}
        {/* 空回复时正文还没有块级元素, 伪元素挂不上去, 光标直接内联在省略号后 */}
        {cursor && !entry.text && <span className="chat-caret" />}
      </div>
      {/* 流式中不给复制: 内容还没写完, 复制到的是半截 */}
      {entry.text && !cursor && (
        <div className="msg-actions -ml-1">
          <CopyButton text={entry.text} title="复制回复 (Markdown)" className="chat-copy" />
        </div>
      )}
    </div>
  );
});

/** 推理过程: 「推理 · N 字」胶囊 (默认收起), 展开为凹陷卡里的灰字 */
const ThinkingView = memo(function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "open" : undefined}>
      <button type="button" className="think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Sparkle className="h-3 w-3" />
        <span>推理</span>
        <span className="think-len">{text.length.toLocaleString()} 字</span>
        <ChevronDown className="chev h-3 w-3" />
      </button>
      {open && <div className="think-body">{text}</div>}
    </div>
  );
});

const NOTICE_ICONS = { info: Info, warning: AlertTriangle, error: XCircle } as const;

/** 会话内通知: 小卡片 + 类型图标, 不自动消失 */
const NoticeRow = memo(function NoticeRow({ entry }: { entry: ChatEntry }) {
  const type = entry.notifyType ?? "info";
  const Icon = NOTICE_ICONS[type];
  return (
    <div className={`notice ${type}`}>
      <Icon className="h-[14px] w-[14px]" />
      <span>{entry.text}</span>
    </div>
  );
});
