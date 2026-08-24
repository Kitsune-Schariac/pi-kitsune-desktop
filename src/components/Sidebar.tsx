import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { PanelKind } from "../App";
import { ProjectList } from "./ProjectList";
import { useSessionStore } from "../store/session";
import { Sparkles, Package, Settings, FolderKanban, Plus, FolderOpen, Loader2 } from "lucide-react";

// 左侧边栏: 功能区 (skill/package/设置) + 项目会话区
export function Sidebar({ onOpenPanel }: { onOpenPanel: (p: PanelKind) => void }) {
  const startSession = useSessionStore((s) => s.startSession);
  const [adding, setAdding] = useState(false);

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

  return (
    <aside className="sidebar-shell flex w-[18%] flex-col bg-[rgb(var(--surface-sunken)/var(--sidebar-alpha))]">
      {/* 品牌区 */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Pi Kitsune</span>
        </div>
        <button
          onClick={() => onOpenPanel("settings")}
          className="rounded-md p-1.5 text-neutral-400 transition hover:bg-neutral-200/70 hover:text-neutral-700"
          title="设置"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      {/* 功能区 */}
      <div className="space-y-1 px-3 py-3">
        <button
          onClick={() => onOpenPanel("skills")}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-neutral-600 transition hover:bg-neutral-200/60 hover:text-neutral-900"
        >
          <Sparkles className="h-4 w-4 text-neutral-500" />
          Skill 管理
        </button>
        <button
          onClick={() => onOpenPanel("packages")}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-neutral-600 transition hover:bg-neutral-200/60 hover:text-neutral-900"
        >
          <Package className="h-4 w-4 text-neutral-500" />
          pi Package
        </button>
        <button
          onClick={() => onOpenPanel("settings")}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-neutral-600 transition hover:bg-neutral-200/60 hover:text-neutral-900"
        >
          <Settings className="h-4 w-4 text-neutral-500" />
          设置
        </button>
      </div>

      {/* 项目会话区 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
            <FolderKanban className="h-3.5 w-3.5" />
            项目会话
          </span>
          <button
            onClick={handleAddProject}
            disabled={adding}
            className="rounded p-1 text-neutral-400 transition hover:bg-neutral-200/70 hover:text-neutral-700 disabled:opacity-40"
            title="添加项目 (选择目录并新建会话)"
          >
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          </button>
        </div>
        <ProjectList />
      </div>

      {/* 底部提示 */}
      {/* 侧边栏是 sunken 灰底, 次要文字比白底上再深一档才够 WCAG AA (neutral-500 在灰底上仅 4.35:1) */}
      <div className="px-4 py-2 text-[11px] text-neutral-600">
        <span className="flex items-center gap-1">
          <FolderOpen className="h-3 w-3" />
          会话数据来自 ~/.pi/agent/sessions
        </span>
      </div>
    </aside>
  );
}
