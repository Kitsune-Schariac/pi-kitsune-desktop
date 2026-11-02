import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useSessionStore } from "../../store/session";
import { useUiStore } from "../../store/ui";
import { buildTimeline } from "../../lib/timeline";
import { TurnView } from "./TurnView";

/**
 * 会话区 (对话形式, 主区): entries → 轮 → 用户气泡 + AI 块 (回复 / 步骤卡片 / 通知)。
 * 滚动与自动跟随: 距底 < 80px 视为跟随中, 用户上滑即暂停; 只有「用户自己发的消息」
 * 和「切会话」会重新打开跟随 (流式期间的工具/回复/通知条目一律不抢跟随权, 否则上翻会被拽回底部)。
 * 「在会话中定位」订阅 ui.locateStepSeq: 目标步骤行滚到视口中央并闪烁。
 * 「回到最新」按钮: 上滑离开底部时浮在输入卡上方居中, 点击恢复跟随; 期间有新条目时带一个小点。
 */
export function Timeline({ inputBarH = 0 }: { inputBarH?: number }) {
  const entries = useSessionStore((s) => {
    const a = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
    return a?.entries ?? [];
  });
  const isStreaming = useSessionStore((s) => {
    const a = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
    return a?.isStreaming ?? false;
  });
  const streamingReplyId = useSessionStore((s) => {
    const a = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
    return a && a.isStreaming ? a.currentAssistantId : null;
  });
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectedId = useUiStore((s) => s.selectedStepId);
  const locateStepSeq = useUiStore((s) => s.locateStepSeq);

  const turns = useMemo(() => buildTimeline(entries), [entries]);

  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // 是否自动跟随滚动: 用户主动上滑查看历史时暂停, 回到底部后恢复
  const autoScrollRef = useRef(true);
  const prevLenRef = useRef(0);
  const prevSessionRef = useRef(activeSessionId);
  // 上滑离开底部时显示「回到最新」按钮; hasNew 标记上滑期间是否又进来了新条目
  const [showJump, setShowJump] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  // 程序化跟随滚动进行中 (smooth 途中"还没到底"): 这段时间不刷新按钮, 否则会闪一下。
  // 用户的滚轮/按下会打断平滑滚动, 同时解除锁, 按钮立刻恢复正常判定
  const followingRef = useRef(false);
  // 点击「回到最新」后的平滑滚动进行中: 这段时间内的跟随也走 smooth, 否则流式 delta 的下一次
  // auto 跟随会立刻瞬移到底, 把滚动过程生吃掉
  const smoothJumpRef = useRef(false);
  const releaseFollowLock = () => {
    followingRef.current = false;
    smoothJumpRef.current = false;
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    // 距底部 < 80px 视为"在底部", 允许自动跟随
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    autoScrollRef.current = atBottom;
    if (atBottom) {
      followingRef.current = false;
      smoothJumpRef.current = false;
      setShowJump(false);
      // 自己滚回底部也算已读, 小点不残留
      setHasNew(false);
    } else if (!followingRef.current) {
      setShowJump(true);
    }
  };

  // 按钮点击: 先拿回跟随权再平滑滚到底。上锁让途中不刷新按钮, 到站后 handleScroll 自动解锁
  const jumpToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    setShowJump(false);
    setHasNew(false);
    followingRef.current = true;
    smoothJumpRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // entries 变化 / 切会话时决定是否跟随滚动。
  // 跟随权只由「用户自己发的消息」恢复: 流式输出期间工具条目、回复、通知会持续追加,
  // 若按「长度变大就跟随」处理, 用户手动上翻看历史会被每一条新条目拽回底部。
  useEffect(() => {
    const sessionChanged = prevSessionRef.current !== activeSessionId;
    prevSessionRef.current = activeSessionId;

    const newLen = entries.length;
    const isNewMessage = newLen > prevLenRef.current;
    prevLenRef.current = newLen;

    if (sessionChanged) {
      // 切会话是新起点: 上一个会话的上翻状态不该带过来, 直接看最新内容
      autoScrollRef.current = true;
      setShowJump(false);
      setHasNew(false);
    } else if (isNewMessage) {
      const last = newLen > 0 ? entries[newLen - 1] : null;
      if (last?.kind === "message" && last.role === "user") {
        autoScrollRef.current = true;
      } else if (!autoScrollRef.current) {
        // 上滑期间进来了新条目: 只在按钮上点一个小点, 不抢滚动位置
        setHasNew(true);
      }
    }

    if (!autoScrollRef.current) return;
    // 新消息 / 平滑回底途中走 smooth; 流式 delta 与切会话瞬间跳 (避免动画堆积卡顿)
    followingRef.current = true;
    endRef.current?.scrollIntoView({
      behavior: smoothJumpRef.current || (isNewMessage && !sessionChanged) ? "smooth" : "auto",
    });
  }, [entries, activeSessionId]);

  // 内容在条目不变的情况下也会长高: 衬线字体按需加载完成后换字重排、Shiki 异步高亮替换代码块、
  // 图片解码。跟随中 (在底部) 时随之贴底, 否则打开历史会话会停在离底部一截的位置, 最后一段压在输入卡下
  const colRef = useRef<HTMLDivElement>(null);
  const hasEntries = entries.length > 0;
  useEffect(() => {
    const col = colRef.current;
    const el = containerRef.current;
    if (!col || !el) return;
    const ro = new ResizeObserver(() => {
      if (!autoScrollRef.current || smoothJumpRef.current) return;
      followingRef.current = true;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, [hasEntries]);

  // 输入卡长高 (统计行 / 排队条出现、多行输入) 会加大底部留白: 跟随中同样补一次贴底
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !autoScrollRef.current || smoothJumpRef.current) return;
    followingRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [inputBarH]);

  const flashTimerRef = useRef<number | null>(null);
  // 「在时间线定位」: 信号递增 → 找选中步骤行 → 滚到中央 + 闪烁。
  // 选中 id 从 getState 读: 选中本身不该触发滚动, 只有显式定位信号才滚
  useEffect(() => {
    if (!locateStepSeq) return;
    const id = useUiStore.getState().selectedStepId;
    if (!id) return;
    let raf = 0;
    let attempts = 0;
    const tryScroll = () => {
      const el = containerRef.current?.querySelector<HTMLElement>(
        `[data-step-id="${CSS.escape(id)}"]`,
      );
      if (!el) {
        // 折叠组由 StepGroup 的 effect 展开, 目标行可能下一帧才渲染出来
        if (attempts++ < 3) raf = requestAnimationFrame(tryScroll);
        return;
      }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      // 强制重开闪烁动画: 移除 class → 读 offsetWidth 触发 reflow → 再加回
      el.classList.remove("chat-flash");
      void el.offsetWidth;
      el.classList.add("chat-flash");
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => el.classList.remove("chat-flash"), 1400);
    };
    raf = requestAnimationFrame(tryScroll);
    return () => {
      cancelAnimationFrame(raf);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    };
  }, [locateStepSeq]);

  return (
    // 外层接住 flex 高度, 按钮才能绝对定位在滚动区下方; 滚动本身仍由内层承担
    <div
      className="relative min-h-0 flex-1"
      // 用户主动滚动的两类入口: 解除跟随锁, 让「回到最新」按钮及时冒出来
      onWheel={releaseFollowLock}
      onPointerDown={releaseFollowLock}
    >
      <div
        ref={containerRef}
        onScroll={handleScroll}
        // overflow-x-hidden 兜底: 任何子元素意外撑宽都不能让时间线横向滚动 (定位时 scrollIntoView 会连带横滚把正文切掉)
        className="chat-scroll h-full overflow-y-auto overflow-x-hidden"
        // 底部 padding = 输入卡高 + bottom-4(16px) + 间隔 24px: 滚动到底消息停在卡片上方间隔处,
        // 滚动过程中消息可平滑滑入卡片后方, 不会被提前截断
        style={{ paddingBottom: inputBarH + 40 }}
      >
        {entries.length === 0 ? (
          <div className="py-20 text-center text-body text-fg-4">输入消息开始对话</div>
        ) : (
          <div ref={colRef} className="chat-col">
            {turns.map((turn, i) => (
              <TurnView
                key={turn.id}
                turn={turn}
                live={isStreaming && i === turns.length - 1}
                streamingReplyId={streamingReplyId}
                selectedId={selectedId}
                revealSeq={locateStepSeq}
              />
            ))}
            {/* 滚动锚点: 自动跟随的 scrollIntoView 目标 */}
            <div ref={endRef} />
          </div>
        )}
      </div>
      {showJump && (
        // 水平居中于滚动区 (与输入卡同一中线基准). 底部偏移 = 卡高 + composer-wrap 底 padding 20
        // + 16 间距 —— inputBarH 只有卡本身高度, 不加 20 按钮会压在输入卡上
        <div className="chat-jump-layer" style={{ bottom: inputBarH + 36 }}>
          <button
            type="button"
            onClick={jumpToBottom}
            aria-label="回到最新消息"
            title="回到最新消息"
            className="chat-jump view-in-soft"
          >
            <ArrowDown size={15} strokeWidth={2} />
            {hasNew && <span className="chat-jump-dot" />}
          </button>
        </div>
      )}
    </div>
  );
}
