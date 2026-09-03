import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Flame } from "lucide-react";

// 自绘标题栏 (无边框窗口): 整窗顶部拖拽区 + 品牌 + 窗口控制三键。
// - 布局: App 外层纵向 flex 的第一行, 全窗宽固定 32px (尽量矮, 桌面工具不喧宾夺主)
// - 拖拽: 容器整体 data-tauri-drag-region (Tauri 原生拖动), 按钮天然排除
// - 窗口控制: capability 已放行 core:window:allow-{minimize,toggle-maximize,close,start-dragging}
// - 关闭走系统窗口销毁路径 → lib.rs on_window_event(Destroyed) → stop_all, 与原生一致
export function TitleBar() {
  return (
    <header
      data-tauri-drag-region
      className="flex h-8 shrink-0 select-none items-center border-b border-[var(--border-soft)] bg-[color-mix(in_oklch,var(--surface)_86%,transparent)] pl-3"
    >
      {/* 品牌 mark (无路径 — 会话信息在侧栏/工具条, 标题栏只承担系统壳职责) */}
      <span className="flex items-center gap-2 text-label font-semibold tracking-wide text-[var(--fg)]">
        <Flame className="h-[15px] w-[15px] text-[var(--accent)]" aria-hidden />
        <span>Pi Kitsune</span>
      </span>

      {/* 窗口控制三键 */}
      <span className="ml-auto flex h-full items-center">
        <button
          onClick={() => getCurrentWindow().minimize()}
          className="grid h-full w-11 place-items-center text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          aria-label="最小化"
          title="最小化"
        >
          <Minus className="h-[15px] w-[15px]" />
        </button>
        <button
          onClick={() => getCurrentWindow().toggleMaximize()}
          className="grid h-full w-11 place-items-center text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          aria-label="最大化 / 还原"
          title="最大化 / 还原"
        >
          <Square className="h-[13px] w-[13px]" />
        </button>
        <button
          onClick={() => getCurrentWindow().close()}
          className="grid h-full w-11 place-items-center text-[var(--muted)] transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--danger)_78%,black)] hover:text-white"
          aria-label="关闭"
          title="关闭"
        >
          <X className="h-[15px] w-[15px]" />
        </button>
      </span>
    </header>
  );
}
