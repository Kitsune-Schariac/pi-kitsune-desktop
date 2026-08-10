import type { PanelKind } from "../App";
import { ProjectList } from "./ProjectList";
import { Sparkles, Package, Settings, FolderKanban, Plus, FolderOpen } from "lucide-react";

// 左侧边栏: 功能区 (skill/package/设置) + 项目会话区
export function Sidebar({ onOpenPanel }: { onOpenPanel: (p: PanelKind) => void }) {
  return (
    <aside className="flex w-[18%] flex-col bg-white/60 backdrop-blur-xl">
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
            onClick={() => onOpenPanel("settings")}
            className="rounded p-1 text-neutral-400 transition hover:bg-neutral-200/70 hover:text-neutral-700"
            title="新建会话 (选择项目)"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <ProjectList />
      </div>

      {/* 底部提示 */}
      <div className="px-4 py-2 text-[11px] text-neutral-400">
        <span className="flex items-center gap-1">
          <FolderOpen className="h-3 w-3" />
          会话数据来自 ~/.pi/agent/sessions
        </span>
      </div>
    </aside>
  );
}
