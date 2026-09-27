import { useEffect, useMemo, useRef } from "react";
import { useSessionStore } from "../../store/session";
import { useUiStore } from "../../store/ui";
import { buildTimeline } from "../../lib/timeline";
import { TurnView } from "./TurnView";

/**
 * 时间线 (框架 C 第三列主区): entries → 轮 → prompt / reply / steps / notice。
 * 滚动与自动跟随逻辑自 MessageList 原样搬入 (新条目强制跟随, 流式只在距底 < 80px 时跟随);
 * 「在时间线定位」订阅 ui.locateStepSeq: 目标步骤行滚到视口中央并闪烁。
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
  const selectedId = useUiStore((s) => s.selectedStepId);
  const locateStepSeq = useUiStore((s) => s.locateStepSeq);

  const turns = useMemo(() => buildTimeline(entries), [entries]);

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
      el.classList.remove("tl-flash");
      void el.offsetWidth;
      el.classList.add("tl-flash");
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => el.classList.remove("tl-flash"), 1400);
    };
    raf = requestAnimationFrame(tryScroll);
    return () => {
      cancelAnimationFrame(raf);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    };
  }, [locateStepSeq]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      // overflow-x-hidden 兜底: 任何子元素意外撑宽都不能让时间线横向滚动 (定位时 scrollIntoView 会连带横滚把正文切掉)
      className="tl-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      // 底部 padding = 输入卡高 + bottom-4(16px) + 间隔 24px: 滚动到底消息停在卡片上方间隔处,
      // 滚动过程中消息可平滑滑入卡片后方, 不会被提前截断
      style={{ paddingBottom: inputBarH + 40 }}
    >
      {entries.length === 0 ? (
        <div className="py-20 text-center text-label text-[var(--fg-4)]">输入消息开始对话</div>
      ) : (
        <div className="tl-timeline">
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
  );
}
