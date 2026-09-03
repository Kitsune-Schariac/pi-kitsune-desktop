import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { PanelKind } from "../App";
import { ProjectList } from "./ProjectList";
import { useSessionStore } from "../store/session";
import {
  Sparkles, Package, Settings, FolderKanban, Plus, FolderOpen, Loader2,
  Search, ChevronRight, PanelLeftClose, PanelLeftOpen,
} from "lucide-react";

// 左侧边栏: 顶部搜索 → 功能区 (skill/package) → 项目会话树 → 底部设置入口
// 结构对齐改版稿 (kitsune-redesign.html .sidebar): 设置入口收敛到树下方一行, 树内不再放功能按钮
export function Sidebar({
  onOpenPanel,
  collapsed,
  onToggleCollapsed,
}: {
  onOpenPanel: (p: PanelKind) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const startSession = useSessionStore((s) => s.startSession);
  const [adding, setAdding] = useState(false);
  // 搜索关键词: 非空时项目树切为全局拍平过滤视图 (Sidebar 持有, 传入 ProjectList 过滤)
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // 全局 "/" 聚焦搜索 (改版稿交互): 输入框/弹窗打开时让位, 不抢焦点
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable;
      // 设置窗/抽屉等全屏覆盖层打开时让位: 层内标题搜索框有输入焦点时不抢 (typing 已拦),
      // 但覆盖层自身不聚焦时 window keydown 仍会触发 —— 检查覆盖层是否存在
      const covered = !!document.querySelector("[data-overlay]");
      if (e.key !== "/" || typing || covered || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 添加项目 = 选目录 + 在该目录起一个会话。项目列表是 Rust 扫 ~/.pi/agent/sessions 反推出来的,
  // 没有独立的"注册项目"动作, 目录里没有会话就无从显示; 会话文件落盘前由 ProjectList 的虚拟项目行兜住
  const handleAddProject = async () => {
    if (adding) return;
    try {
      const dir = await open({ directory: true, multiple: false, title: "选择项目目录" });
      if (typeof dir !== "string") return; // 用户取消
      setAdding(true);
      await startSession(dir);
    } catch (e) {
      console.error("添加项目失败", e);
    }
    setAdding(false);
  };

  // 折叠态只剩一条窄栏: 显示展开钮 + 竖排迷你图标 (悬停 title 提示), 不渲染树
  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-[var(--border-soft)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--sidebar-alpha)_*_100%),transparent)] py-2">
        <button
          onClick={onToggleCollapsed}
          className="rounded-md p-2 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          title="展开侧栏"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <button
          onClick={() => onOpenPanel("skills")}
          className="rounded-md p-2 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          title="Skill 管理"
        >
          <Sparkles className="h-4 w-4" />
        </button>
        <button
          onClick={() => onOpenPanel("packages")}
          className="rounded-md p-2 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          title="pi Package"
        >
          <Package className="h-4 w-4" />
        </button>
        <button
          onClick={() => onOpenPanel("settings")}
          className="mt-auto rounded-md p-2 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          title="设置"
        >
          <Settings className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-[288px] shrink-0 flex-col bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--sidebar-alpha)_*_100%),transparent)]">
      {/* 头部: 折叠钮 + 品牌; 折叠钮放头部左侧, 悬停/点击收起 (改版稿 rail toggle 位置语义) */}
      <div className="flex items-center gap-1 px-3 py-3">
        <button
          onClick={onToggleCollapsed}
          className="rounded-md p-2 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          title="收起侧栏"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
        <span className="truncate text-title font-semibold text-[var(--fg)]">Pi Kitsune</span>
      </div>

      {/* 顶部搜索: "/" 全局聚焦; 输入后树切全局拍平过滤 (query 传给 ProjectList) */}
      <div className="px-3 pb-1">
        <div className="group relative flex items-center">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--faint)]" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="搜索会话或项目…"
            aria-label="搜索会话"
            className="w-full rounded-md border border-[var(--border-soft)] bg-[color-mix(in_oklch,var(--surface-base)_55%,transparent)] py-2 pl-8 pr-7 text-body text-[var(--fg)] placeholder:text-[var(--faint)] focus:border-[var(--accent)] focus:outline-none"
          />
          {/* "/" 快捷键徽标: 输入中隐藏, 聚焦态可见提示 */}
          <span className="pointer-events-none absolute right-2 rounded border border-[var(--border-soft)] bg-[var(--surface-2)] px-1 font-mono text-micro text-[var(--faint)]">
            /
          </span>
        </div>
      </div>

      {/* 功能区 (Skill / Package) */}
      <div className="px-2 py-2">
        <button
          onClick={() => onOpenPanel("skills")}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-body text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-[var(--faint)]" />
          Skill 管理
        </button>
        <button
          onClick={() => onOpenPanel("packages")}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-body text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
        >
          <Package className="h-4 w-4 shrink-0 text-[var(--faint)]" />
          pi Package
        </button>
      </div>

      {/* 项目会话树 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3 pb-1 pt-1">
          <span className="flex items-center gap-2 text-mini font-medium uppercase tracking-wide text-[var(--faint)]">
            <FolderKanban className="h-4 w-4" />
            项目会话
          </span>
          <button
            onClick={handleAddProject}
            disabled={adding}
            className="rounded p-1 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)] disabled:opacity-40"
            title="添加项目 (选择目录并新建会话)"
          >
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>
        <ProjectList searchQuery={query} />
        {/* 搜索模式提示: 全局拍平, 不按项目分组 */}
        {query.trim() !== "" && (
          <div className="px-4 py-1 text-mini leading-relaxed text-[var(--faint)]">
            搜索中：会话不按项目分组
          </div>
        )}
      </div>

      {/* 底部: 设置入口 (主入口) + 会话数据库路径小字 */}
      <div className="shrink-0 border-t border-[var(--border-soft)] px-2 pb-3 pt-2">
        <button
          onClick={() => onOpenPanel("settings")}
          className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
        >
          <span className="flex min-w-0 items-center gap-2 text-label">
            <Settings className="h-4 w-4 shrink-0 text-[var(--faint)]" />
            设置
          </span>
          <ChevronRight className="h-3 w-3 shrink-0 text-[var(--faint)]" />
        </button>
        {/* 会话数据库路径弱化为小字 (不可删, 改版稿保留项) */}
        <div className="flex items-center gap-1 px-2 py-1 text-micro text-[var(--faint)]">
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="truncate" title="会话文件存放位置">会话数据来自 ~/.pi/agent/sessions</span>
        </div>
      </div>
    </aside>
  );
}
