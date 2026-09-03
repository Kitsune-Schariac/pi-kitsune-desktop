import type { ReactNode } from "react";

// 统一右侧面板容器 (改版稿 .side-panel): 与 main 为 flex 兄弟, 展开时 main 自然让位 (非浮层)。
// 固定 380px; 各面板 (舰队/Trellis/Git) 内容组件灌进 children, 自身不再带宽度/拖拽/圆角外壳。
// 显隐由 App 单一 rightPanel state 控制 + hidden 属性 (配合 index.css [hidden]{display:none} 保底)。
export function RightPanel({ children }: { children: ReactNode }) {
  return (
    <aside className="flex w-[380px] shrink-0 flex-col overflow-hidden border-l border-[var(--border-soft)] bg-[color-mix(in_oklch,var(--surface-base)_calc(var(--chat-alpha)_*_100%),transparent)]">
      {children}
    </aside>
  );
}
