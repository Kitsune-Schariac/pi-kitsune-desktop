import { memo, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, Info, Sparkle, XCircle } from "lucide-react";
import type { ChatEntry } from "../../store/session";
import { isEmptyReply, pendingPhase } from "../../lib/timeline";
import type { PendingPhase, TimelineItem, Turn } from "../../lib/timeline";
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
 * 流式中界面上没有东西在长 (首 token 前 / 工具跑完等下一次调用 / 生成工具参数) 时,
 * AI 块末尾挂一行等待提示; 刚发出提问还没有任何 AI 条目时也照样立起 AI 块来承载它。
 * 空回复 (无正文无推理) 不渲染: 流式中由等待提示接管, 结束后与历史回放一致, 不留孤零零的「…」。
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
  const rest = (prompt ? turn.items.slice(1) : turn.items).filter(
    (item) => item.kind !== "reply" || !isEmptyReply(item.entry),
  );
  const phase = live ? pendingPhase(turn) : null;
  return (
    <article className="chat-turn">
      {prompt && <PromptView entry={prompt.entry} />}
      {(rest.length > 0 || phase) && (
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
                    // 生成工具参数时正文已写完, 光标不再闪 (由下方「生成工具调用中」接手)
                    cursor={live && item.entry.id === streamingReplyId && !item.entry.draftingTool}
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
            {/* 固定在条目列表之后的同一位置: 条目增删不会让它重挂载, 计时连续;
                key=阶段 让「等待 → 生成工具调用」切换时重新计时 */}
            {phase && <PendingRow key={phase} phase={phase} />}
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

/**
 * AI 回复: 推理折叠 + Markdown 正文; 流式中末尾由 .streaming 的伪元素跟一个光标。
 * 空回复 (无正文无推理) 由 TurnView 过滤掉, 到这里至少有其一
 */
const ReplyView = memo(function ReplyView({ entry, cursor }: { entry: ChatEntry; cursor: boolean }) {
  return (
    <div className="ai-reply-wrap">
      {entry.thinking ? <ThinkingView text={entry.thinking} /> : null}
      {entry.text ? (
        <div className={`ai-reply${cursor ? " streaming" : ""}${entry.thinking ? " mt-3" : ""}`}>
          <Markdown text={entry.text} />
        </div>
      ) : cursor ? (
        // 推理阶段 / 推理刚完正文首字未到: 推理胶囊下挂省略号 + 光标
        // (正文还没有块级元素, 伪元素挂不上去, 光标直接内联)
        <div className="ai-reply mt-3">
          <span className="ai-dots">…</span>
          <span className="chat-caret" />
        </div>
      ) : null}
      {/* 流式中不给复制: 内容还没写完, 复制到的是半截 */}
      {entry.text && !cursor && (
        <div className="msg-actions -ml-1">
          <CopyButton text={entry.text} title="复制回复 (Markdown)" className="chat-copy" />
        </div>
      )}
    </div>
  );
});

const PENDING_LABEL: Record<PendingPhase, string> = {
  waiting: "等待模型响应",
  drafting: "生成工具调用中",
};

/**
 * 等待提示: 三个起伏的点 + 阶段文案 + 已等时长 (满 1s 才显示, 快模型不闪数字)。
 * 计时从挂载算起 —— 挂载点就是「界面上最后一次有东西在长」的时刻, 秒表自己走,
 * 不进 store (与输入卡统计条同理: store 只存事实, 渲染节拍放组件里)
 */
function PendingRow({ phase }: { phase: PendingPhase }) {
  const [since] = useState(() => Date.now());
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.floor((Date.now() - since) / 1000);
  return (
    <div className="ai-pending" role="status">
      <span className="ai-pending-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span>{PENDING_LABEL[phase]}</span>
      {/* 秒数每秒变, 不让读屏器跟着念 */}
      {sec >= 1 && (
        <span className="ai-pending-time" aria-hidden>
          {sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`}
        </span>
      )}
    </div>
  );
}

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
