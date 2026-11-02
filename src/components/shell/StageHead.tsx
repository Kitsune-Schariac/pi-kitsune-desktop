import { useEffect, useState } from "react";
import { Folder, MoreHorizontal, PanelRight, X } from "lucide-react";
import { useSessionStore } from "../../store/session";
import { useUiStore } from "../../store/ui";
import { Badge } from "../ui";

/** 路径最后一段 (项目名展示用): 兼容 Windows 反斜杠 */
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * 主区列头: 会话标题 + 项目 (cwd 悬停) + 运行中徽标 +
 * 检查器开关 + 「更多」菜单 (关闭会话)。错误条由 App 渲染在它下方;
 * 队列指示已迁入输入卡上沿 (QueueIndicator)。
 */
export function StageHead() {
  const active = useSessionStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : null,
  );
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const stopSession = useSessionStore((s) => s.stopSession);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const setInspectorOpen = useUiStore((s) => s.setInspectorOpen);
  const [menuOpen, setMenuOpen] = useState(false);

  // Esc 关闭「更多」菜单 (与其它弹层一致的手感)
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!active) return null;

  return (
    // 单行列头 (--bar-h): 与会话列表 / 检查器列头同高, 底线贯通。cwd 收进项目名的悬停提示
    <header className="bar gap-3 px-5">
      <h1 className="min-w-0 truncate text-lead font-semibold text-fg">
        {active.sessionName || baseName(active.cwd)}
      </h1>
      <span
        className="flex min-w-0 shrink items-center gap-1 text-label text-fg-3"
        title={active.cwd}
      >
        <Folder className="h-[14px] w-[14px] shrink-0 text-fg-4" />
        <span className="truncate">{baseName(active.cwd)}</span>
      </span>
      {active.isStreaming && (
        <Badge className="gap-2">
          <span className="live-dot" />
          运行中
        </Badge>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          onClick={() => setInspectorOpen(!inspectorOpen)}
          className={`grid h-8 w-8 place-items-center rounded-md transition duration-fast ease-out ${
            inspectorOpen
              ? "bg-card text-fg shadow-[var(--shadow-sm),inset_0_0_0_1px_var(--edge)]"
              : "text-fg-3 hover:bg-hover hover:text-fg"
          }`}
          title={inspectorOpen ? "收起检查器" : "展开检查器"}
          aria-label="检查器"
          aria-pressed={inspectorOpen}
        >
          <PanelRight className="h-4 w-4" />
        </button>
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="grid h-8 w-8 place-items-center rounded-md text-fg-3 transition duration-fast ease-out hover:bg-hover hover:text-fg"
            title="更多"
            aria-label="更多"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <>
              {/* 透明遮罩: 点击任意处关闭 */}
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="popover absolute right-0 top-full z-50 mt-1 w-40 p-1 view-in-soft">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    if (activeSessionId) stopSession(activeSessionId);
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-body text-fg-2 transition duration-fast ease-out hover:bg-hover hover:text-fg"
                >
                  <X className="h-[14px] w-[14px]" />
                  关闭会话
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
