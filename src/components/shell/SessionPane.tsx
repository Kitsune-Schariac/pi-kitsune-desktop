import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Database, Loader2, Plus, Search } from "lucide-react";
import { ProjectList } from "../ProjectList";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { useSessionStore } from "../../store/session";
import { useUiStore, type SessionListMode } from "../../store/ui";
import { Segmented } from "../ui";

const LIST_MODES: { value: SessionListMode; label: string }[] = [
  { value: "recent", label: "最近" },
  { value: "projects", label: "项目" },
];

/**
 * 会话列表 (第二列): 列头 (搜索 + 新建) + 「最近 / 项目」分段 + 列表体 + 会话库路径小字。
 * 收起与拖拽调宽由 paneOpen / 右缘手柄控制。
 * 列表体 (最近 / 项目两视图) 都走 ProjectList, 打开 / 删除 / 菜单逻辑单源。
 */
export function SessionPane() {
  const paneOpen = useUiStore((s) => s.paneOpen);
  const listMode = useUiStore((s) => s.listMode);
  const setListMode = useUiStore((s) => s.setListMode);
  const startSession = useSessionStore((s) => s.startSession);
  const { width, dragging, onDragStart } = useResizableWidth({
    storageKey: "kitsune.sidebarWidth",
    defaultValue: 264,
    min: 200,
    max: 480,
  });
  const [adding, setAdding] = useState(false);
  // 搜索关键词: 非空时项目树切为全局拍平过滤视图 (Sidebar 持有的旧行为原样保留)
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // 全局 "/" 聚焦搜索: 输入框/弹窗/覆盖层打开时让位, 不抢焦点
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable;
      const covered = !!document.querySelector("[data-overlay]");
      if (e.key !== "/" || typing || covered || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 新建会话 = 选目录 + 在该目录起一个会话。项目列表是 Rust 扫会话文件反推的,
  // 目录里没有会话就无从显示, 落盘前的空项目由 ProjectList 的虚拟项目行兜住
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

  return (
    <aside
      data-pane={paneOpen ? "open" : "closed"}
      style={{ width: paneOpen ? width : 0 }}
      className="shell-sessions relative shrink-0 overflow-hidden"
    >
      {/* 内层锁死展开宽度: 收起动画压缩外框时内容不跟着变形 (只被裁切) */}
      <div className="flex h-full flex-col" style={{ width }}>
        {/* 列头: 与主区 / 检查器同高 (--bar-h), 底线横向贯通 */}
        <div className="bar gap-2 px-3">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-card px-2 text-fg-4 shadow-sm transition duration-fast ease-out focus-within:border-fg-3 focus-within:shadow-[var(--shadow-sm),0_0_0_3px_var(--accent-soft)]">
            <Search className="h-[14px] w-[14px] shrink-0" />
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
              placeholder="搜索会话或项目"
              aria-label="搜索会话"
              className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-4"
            />
            <kbd className="grid h-5 min-w-5 shrink-0 place-items-center rounded-[4px] bg-well px-1 font-mono text-meta text-fg-4 shadow-[inset_0_0_0_1px_var(--line)]">
              /
            </kbd>
          </label>
          <button
            onClick={handleAddProject}
            disabled={adding}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-card text-fg-3 shadow-sm transition duration-fast ease-out hover:border-line-2 hover:text-fg disabled:opacity-40"
            title="新建会话 (选择目录)"
            aria-label="新建会话"
          >
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>

        {/* 最近 / 项目: 分段控件 (全站视图切换统一用 Segmented) */}
        <div className="px-3 pb-1 pt-3">
          <Segmented
            fill
            size="sm"
            value={listMode}
            options={LIST_MODES}
            onChange={setListMode}
            ariaLabel="会话列表视图"
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <ProjectList searchQuery={query} mode={listMode} />
          {/* 搜索模式提示: 全局拍平, 不按项目分组 (原 Sidebar 行为; 最近视图本就跨项目, 无需提示) */}
          {query.trim() !== "" && listMode === "projects" && (
            <div className="px-4 py-1 text-meta leading-relaxed text-fg-4">
              搜索中：会话不按项目分组
            </div>
          )}
        </div>

        {/* 会话数据库路径弱化为小字 (改版稿保留项) */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-t border-line px-4 text-meta text-fg-4">
          <Database className="h-3 w-3 shrink-0" />
          <span className="truncate" title="会话文件存放位置">
            ~/.pi/agent/sessions
          </span>
        </div>
      </div>

      {/* 右缘宽度拖拽手柄: 热区骑在边界上, 日常隐藏, hover/拖拽浮现竖线提示可调 */}
      <div
        onMouseDown={onDragStart}
        className="group absolute inset-y-0 right-0 z-10 w-[7px] cursor-col-resize"
        title="拖动调整宽度"
      >
        <div
          className={`absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-colors duration-fast ${
            dragging ? "bg-fg-3" : "bg-transparent group-hover:bg-line-2"
          }`}
        />
      </div>
    </aside>
  );
}
