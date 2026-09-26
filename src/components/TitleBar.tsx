import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Minus, Square, X } from "lucide-react";

// logo 用 new URL 走 Vite 资产解析: 本项目没有 vite/client 类型声明文件,
// import "*.svg" 的写法会被 tsc (noUnusedLocals / 缺模块声明) 拒绝
const logoUrl = new URL("../assets/logo.svg", import.meta.url).href;

// 自绘标题栏 (无边框窗口): 品牌 (logo + 衬线字标 + 版本) | 拖拽区 | 窗口控制三键。
// - 布局: App 外层纵向 flex 的第一行, 全窗宽固定 36px
// - 拖拽: 容器整体 data-tauri-drag-region (Tauri 原生拖动), 按钮天然排除
// - 窗口控制: capability 已放行 core:window:allow-{minimize,toggle-maximize,close,start-dragging}
// - 关闭走系统窗口销毁路径 → lib.rs on_window_event(Destroyed) → stop_all, 与原生一致
// - 版本号: 自绘壳没有系统边框, 应用版本无处可见; 从 Rust 端 app_version 命令取
//   (编译期 CARGO_PKG_VERSION, 与 tauri.conf.json 版本由 bump-version.mjs 同步)
export function TitleBar() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>("app_version")
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center gap-3 border-b border-[var(--line)] bg-[var(--rail)] pl-3"
    >
      {/* 品牌: logo 用 --f-display 衬线字标 (纯拉丁, 中文禁套衬线斜体) */}
      <span className="flex items-center gap-2">
        <img src={logoUrl} alt="" className="h-4 w-4" aria-hidden />
        <span className="[font-family:var(--f-display)] text-head italic leading-none tracking-tight text-fg">
          Pi Kitsune
        </span>
        {version && (
          <span className="font-mono text-micro font-normal text-fg-4">v{version}</span>
        )}
      </span>

      {/* 窗口控制三键 */}
      <span className="ml-auto flex h-full items-center">
        <button
          onClick={() => getCurrentWindow().minimize()}
          className="grid h-full w-11 place-items-center text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
          aria-label="最小化"
          title="最小化"
        >
          <Minus className="h-[15px] w-[15px]" />
        </button>
        <button
          onClick={() => getCurrentWindow().toggleMaximize()}
          className="grid h-full w-11 place-items-center text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
          aria-label="最大化 / 还原"
          title="最大化 / 还原"
        >
          <Square className="h-[13px] w-[13px]" />
        </button>
        <button
          onClick={() => getCurrentWindow().close()}
          className="grid h-full w-11 place-items-center text-fg-3 transition-colors duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--err)_78%,black)] hover:text-white"
          aria-label="关闭"
          title="关闭"
        >
          <X className="h-[15px] w-[15px]" />
        </button>
      </span>
    </header>
  );
}
