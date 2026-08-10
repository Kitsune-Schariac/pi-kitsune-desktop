import { useEffect, useState } from "react";
import { X, BarChart3, Palette } from "lucide-react";
import { TokenStatsPanel } from "./TokenStatsPanel";
import { ThemePanel } from "./ThemePanel";

// 设置窗口: 模态弹窗 (替代原右侧抽屉)
// 布局: 左侧菜单列 (预留扩展位) + 右侧内容区
export function SettingsWindow({ onClose }: { onClose: () => void }) {
  // 当前选项卡
  const [tab, setTab] = useState<"stats" | "theme">("theme");

  // Esc 关闭 (卸载时移除监听)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        // 点击遮罩本身关闭 (不拦截窗口内部点击)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-[80vh] w-[860px] max-w-[92vw] overflow-hidden rounded-2xl border border-neutral-200 bg-panel shadow-2xl">
        {/* 左侧菜单列 */}
        <aside className="flex w-44 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
          <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
            <span className="text-sm font-semibold text-neutral-800">设置</span>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-neutral-400 transition hover:bg-neutral-200/70 hover:text-neutral-700"
              title="关闭 (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <nav className="space-y-1 p-2">
            <button
              onClick={() => setTab("theme")}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                tab === "theme"
                  ? "bg-panel font-medium text-neutral-900 shadow-sm ring-1 ring-neutral-200"
                  : "text-neutral-600 hover:bg-neutral-200/60 hover:text-neutral-900"
              }`}
            >
              <Palette className="h-4 w-4 text-neutral-500" />
              主题
            </button>
            <button
              onClick={() => setTab("stats")}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                tab === "stats"
                  ? "bg-panel font-medium text-neutral-900 shadow-sm ring-1 ring-neutral-200"
                  : "text-neutral-600 hover:bg-neutral-200/60 hover:text-neutral-900"
              }`}
            >
              <BarChart3 className="h-4 w-4 text-neutral-500" />
              Token 统计
            </button>
          </nav>
        </aside>

        {/* 右侧内容区 (独立滚动) */}
        <div className="flex-1 overflow-y-auto">
          {tab === "theme" && <ThemePanel />}
          {tab === "stats" && <TokenStatsPanel />}
        </div>
      </div>
    </div>
  );
}
