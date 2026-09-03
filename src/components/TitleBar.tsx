import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Flame } from "lucide-react";
import { useSessionStore } from "../store/session";

// 自绘标题栏 (无边框窗口): 整窗顶部拖拽区 + 品牌 + 当前会话路径 + 窗口控制三键。
// - 布局: App 外层纵向 flex 的第一行, 全窗宽固定 44px
// - 拖拽: 容器整体 data-tauri-drag-region (Tauri 原生拖动), 按钮天然排除
// - 窗口控制: capability 已放行 core:window:allow-{minimize,toggle-maximize,close,start-dragging}
// - 关闭走系统窗口销毁路径 → lib.rs on_window_event(Destroyed) → stop_all, 与原生一致
export function TitleBar() {
  const sessionPath = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.sessionPath : null;
  });
  // 路径: 活跃会话的 sessionPath 真实值; 无会话时显示会话数据源目录 (改版稿 tb-path 语义)
  const pathText = sessionPath || "~/.pi/agent/sessions";

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 shrink-0 select-none items-center gap-2.5 border-b border-[var(--border-soft)] bg-[color-mix(in_oklch,var(--surface)_86%,transparent)] px-3"
    >
      {/* 品牌 mark + 数据源路径 */}
      <span className="flex items-center gap-2 pl-1 text-title font-semibold tracking-wide text-[var(--fg)]">
        <Flame className="h-[17px] w-[17px] text-[var(--accent)]" aria-hidden />
        <span>Pi Kitsune</span>
      </span>
      <span
        className="max-w-[300px] truncate rounded-md border border-[var(--border-soft)] bg-[color-mix(in_oklch,var(--surface-base)_60%,transparent)] px-2.5 py-0.5 font-mono text-mini text-[var(--faint)]"
        title="会话数据源目录"
      >
        {pathText}
      </span>

      {/* 右侧: 本地就绪状态点 + 窗口控制 */}
      <span className="ml-auto flex items-center gap-2.5">
        <span
          className="flex items-center gap-1.5 font-mono text-mini text-[var(--muted)]"
          title="本机会话 · 状态来自会话文件"
        >
          <i className="h-1.5 w-1.5 rounded-full bg-[var(--ok)] shadow-[0_0_6px_var(--ok)]" />
          本地 · 就绪
        </span>
        <span className="flex items-center gap-0.5">
          <button
            onClick={() => getCurrentWindow().minimize()}
            className="grid h-7 w-10 place-items-center rounded-md text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
            aria-label="最小化"
            title="最小化"
          >
            <Minus className="h-[15px] w-[15px]" />
          </button>
          <button
            onClick={() => getCurrentWindow().toggleMaximize()}
            className="grid h-7 w-10 place-items-center rounded-md text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
            aria-label="最大化 / 还原"
            title="最大化 / 还原"
          >
            <Square className="h-[13px] w-[13px]" />
          </button>
          <button
            onClick={() => getCurrentWindow().close()}
            className="grid h-7 w-10 place-items-center rounded-md text-[var(--muted)] transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--danger)_78%,black)] hover:text-white"
            aria-label="关闭"
            title="关闭"
          >
            <X className="h-[15px] w-[15px]" />
          </button>
        </span>
      </span>
    </header>
  );
}
