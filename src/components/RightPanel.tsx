import type { ReactNode } from "react";
import { useResizableWidth } from "../hooks/useResizableWidth";

// 统一右侧面板容器 (改版稿 .side-panel): 与 main 为 flex 兄弟, 展开时 main 自然让位 (非浮层)。
// 默认 380px; 左缘手柄拖拽调宽 (hook 自持宽度 + localStorage 持久化, App 零感知)。
// 各面板 (舰队/Trellis/Git) 内容组件灌进 children, 自身不带圆角外壳。
// 显隐由 App 单一 rightPanel state 控制 + hidden 属性 (配合 index.css [hidden]{display:none} 保底)。
export function RightPanel({ children }: { children: ReactNode }) {
  const { width, dragging, onDragStart } = useResizableWidth({
    storageKey: "kitsune.rightPanelWidth",
    defaultValue: 380,
    min: 280,
    max: 720,
    direction: -1,
  });

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col overflow-hidden border-l border-[var(--border-soft)] bg-[color-mix(in_oklch,var(--surface-base)_calc(var(--chat-alpha)_*_100%),transparent)]"
    >
      {children}
      {/* 左缘宽度拖拽手柄: 热区骑在边界内侧 (overflow-hidden 裁不掉容器外部分), 日常隐藏,
          hover/拖拽浮现竖线; 面板内容自带左右 padding, 热区不挡交互 */}
      <div
        onMouseDown={onDragStart}
        className="group absolute inset-y-0 left-0 z-10 w-[7px] cursor-col-resize"
        title="拖动调整宽度"
      >
        <div
          className={`absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-colors duration-fast ${
            dragging ? "bg-[var(--accent)]" : "bg-transparent group-hover:bg-[var(--border-strong)]"
          }`}
        />
      </div>
    </aside>
  );
}
