// 桌宠头顶的文字气泡与待办角标
//
// 与 stage.ts 同一套路: 对外是几个命令函数, 走 window CustomEvent 投递给组件,
// 大脑只管调用, 不必拿组件引用; 调试时也能直接从 devtools / CDP 派发。
// 气泡和角标都画在画布的透明区域里, 那里是点击穿透的, 不会挡住用户点身后的窗口。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentMonitor } from "@tauri-apps/api/window";
import { onStageEvent } from "./stage";

const BUBBLE_EVENT = "pet-bubble";
const BADGE_EVENT = "pet-badge";

/** 冒一句话, ms 毫秒后自动收起; 新的一句直接替换旧的 */
export function showBubble(text: string, ms: number) {
  window.dispatchEvent(new CustomEvent(BUBBLE_EVENT, { detail: { text, ms } }));
}

export function hideBubble() {
  window.dispatchEvent(new CustomEvent(BUBBLE_EVENT, { detail: { text: null, ms: 0 } }));
}

/** 角标数字 (待看会话数), 0 隐藏 */
export function setBadge(count: number) {
  window.dispatchEvent(new CustomEvent(BADGE_EVENT, { detail: { count } }));
}

/** 气泡离画布可见边缘的最小留白 */
const EDGE_GAP = 4;

interface Props {
  canvasW: number;
  canvasH: number;
  charW: number;
  charH: number;
}

export function Bubble({ canvasW, canvasH, charW, charH }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  // 画布在屏幕上真正看得见的横向范围 (相对画布左边, 逻辑像素)。角色贴着屏幕边缘时
  // 画布有一部分在屏幕外, 气泡要往里收, 否则半句话看不见
  const [vis, setVis] = useState({ left: 0, right: canvasW });
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let timer = 0;
    const onBubble = (e: Event) => {
      const { text, ms } = (e as CustomEvent<{ text: string | null; ms: number }>).detail;
      window.clearTimeout(timer);
      setText(text);
      if (text) timer = window.setTimeout(() => setText(null), ms);
    };
    const onBadge = (e: Event) => setCount((e as CustomEvent<{ count: number }>).detail.count);
    window.addEventListener(BUBBLE_EVENT, onBubble);
    window.addEventListener(BADGE_EVENT, onBadge);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(BUBBLE_EVENT, onBubble);
      window.removeEventListener(BADGE_EVENT, onBadge);
    };
  }, []);

  // 可见范围只在"冒泡时"和"窗口挪完位置时"重算: 气泡显示期间宠物一般不动,
  // 不值得为它常驻轮询窗口位置
  useEffect(() => {
    let alive = true;
    const measure = async () => {
      const mon = await currentMonitor().catch(() => null);
      if (!mon || !alive) return;
      const s = mon.scaleFactor;
      const waLeft = mon.workArea.position.x / s;
      const waRight = (mon.workArea.position.x + mon.workArea.size.width) / s;
      // screenX 是 CSS 像素, 与逻辑像素同口径
      setVis({
        left: Math.max(0, waLeft - window.screenX),
        right: Math.min(canvasW, waRight - window.screenX),
      });
    };
    if (text) void measure();
    const off = onStageEvent((e) => {
      if (text && e.foot) void measure();
    });
    return () => {
      alive = false;
      off();
    };
  }, [text, canvasW]);

  // 量出气泡实际宽度后再决定往哪边收: 默认居中在角色头顶, 超出可见范围就平移回来
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el || !text) return;
    const w = el.offsetWidth;
    const center = canvasW / 2;
    const lo = vis.left + EDGE_GAP + w / 2;
    const hi = vis.right - EDGE_GAP - w / 2;
    setOffset(lo <= hi ? Math.min(Math.max(center, lo), hi) - center : 0);
  }, [text, vis, canvasW]);

  const headY = canvasH - charH;
  const maxW = Math.max(80, Math.min(canvasW, vis.right - vis.left) - EDGE_GAP * 2);

  return (
    <>
      {text && (
        <>
          <div
            ref={bubbleRef}
            className="text-label"
            style={{
              position: "absolute",
              left: canvasW / 2 + offset,
              bottom: canvasH - headY + 10,
              transform: "translateX(-50%)",
              maxWidth: maxW,
              width: "max-content",
              padding: "6px 10px",
              borderRadius: 10,
              background: "var(--bg)",
              color: "var(--fg)",
              border: "1px solid var(--line-2)",
              boxShadow: "0 2px 8px oklch(0% 0 0 / 0.18)",
              wordBreak: "break-word",
              pointerEvents: "none",
            }}
          >
            {/* 最多三行, 再长就省略: 气泡是提醒不是阅读器。截断放内层: line-clamp 和 padding 写在同一个元素上时, overflow 按内边距框裁剪,
                第四行会从底部留白里漏出半截 */}
            <div
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {text}
            </div>
          </div>
          {/* 小尾巴始终指向角色头顶, 气泡被边缘推开时也不跟着跑 */}
          <div
            style={{
              position: "absolute",
              left: canvasW / 2 - 5,
              bottom: canvasH - headY + 5,
              width: 10,
              height: 10,
              background: "var(--bg)",
              borderRight: "1px solid var(--line-2)",
              borderBottom: "1px solid var(--line-2)",
              transform: "rotate(45deg)",
              pointerEvents: "none",
            }}
          />
        </>
      )}
      {count > 0 && (
        <div
          className="text-label"
          style={{
            position: "absolute",
            // 帧的四周通常留有透明边, 往里收一点才贴得住角色本体
            left: (canvasW + charW) / 2 - 30,
            bottom: canvasH - headY - 30,
            minWidth: 20,
            height: 20,
            padding: "0 6px",
            borderRadius: 10,
            background: "var(--accent)",
            color: "oklch(100% 0 0)",
            fontWeight: 600,
            lineHeight: "20px",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {count > 99 ? "99+" : count}
        </div>
      )}
    </>
  );
}
