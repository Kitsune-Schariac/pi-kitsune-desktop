import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

// 面板宽度拖拽调宽 (容器自持宽度 state, flex 兄弟布局自动让位, 布局方零感知)。
// 手柄 mousedown → window 级 mousemove/mouseup 兜底 (指针划出窗口、松手在窗外也不丢事件),
// 结束后 clamp 落盘 localStorage, 重开面板恢复宽度。
// direction: +1 手柄贴容器右缘 (往右拖变宽 → 左侧栏); -1 手柄贴左缘 (往左拖变宽 → 右侧面板)
export function useResizableWidth({
  storageKey,
  defaultValue,
  min,
  max,
  direction = 1,
}: {
  storageKey: string;
  defaultValue: number;
  min: number;
  max: number;
  direction?: 1 | -1;
}) {
  const [width, setWidth] = useState(() => {
    // 注意 Number(null) === 0: getItem 无 key 返回 null, 须先转 NaN 再判非法回退默认
    const saved = Number(localStorage.getItem(storageKey) ?? NaN);
    // 存档缺失/非法 (手改或版本变更) 回退默认, 越界存档收敛回合法区间
    return clampWidth(Number.isFinite(saved) ? saved : defaultValue, min, max);
  });
  const [dragging, setDragging] = useState(false);
  // 拖拽起点快照 (指针 x + 起始宽度), window 级事件持续期间有效
  const startRef = useRef<{ x: number; w: number } | null>(null);
  // 落盘取最新宽用: mousemove 高频 setState, 松手瞬间 state 尚未落定, 由 ref 兜
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const s = startRef.current;
      if (!s) return;
      // 指针位移 × 方向: 左缘容器的位移方向与宽度变化相反
      const delta = (e.clientX - s.x) * direction;
      setWidth(clampWidth(s.w + delta, min, max));
    };
    const onUp = () => {
      startRef.current = null;
      setDragging(false);
      localStorage.setItem(storageKey, String(widthRef.current));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, storageKey, min, max, direction]);

  const onDragStart = (e: ReactMouseEvent) => {
    // preventDefault 阻止拖拽过程选中面板文本
    e.preventDefault();
    startRef.current = { x: e.clientX, w: widthRef.current };
    setDragging(true);
  };

  return { width, dragging, onDragStart };
}

// clamp 到 [min, max], 且给主内容区留 420px 底线 —— 窄窗口下侧栏也挤不没消息流
function clampWidth(w: number, min: number, max: number): number {
  const ceiling = Math.min(max, Math.max(min, window.innerWidth - 420));
  return Math.round(Math.min(ceiling, Math.max(min, w)));
}
