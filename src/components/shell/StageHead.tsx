import { useEffect, useState } from "react";
import { Folder, MoreHorizontal, PanelRight, X } from "lucide-react";
import { useSessionStore } from "../../store/session";
import { useUiStore } from "../../store/ui";

/** 路径最后一段 (项目名展示用): 兼容 Windows 反斜杠 */
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * 主区头部: 会话标题 + 元信息 (项目 / cwd 悬停 / 运行中胶囊) +
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
    <header className="flex shrink-0 items-center gap-4 border-b border-[var(--line)] px-5 py-3">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-title font-medium text-[var(--fg)]">
          {active.sessionName || baseName(active.cwd)}
        </h1>
        <div className="mt-1 flex items-center gap-3 text-mini text-[var(--fg-3)]">
          <span className="flex shrink-0 items-center gap-1">
            <Folder className="h-3 w-3" />
            {baseName(active.cwd)}
          </span>
          <span className="truncate font-mono text-micro text-[var(--fg-4)]" title={active.cwd}>
            {active.cwd}
          </span>
          {active.isStreaming && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-1 text-[var(--accent)]">
              <span className="flame" />
              运行中
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={() => setInspectorOpen(!inspectorOpen)}
          className={`grid h-8 w-8 place-items-center rounded-md transition-colors duration-fast ease-out ${
            inspectorOpen
              ? "text-[var(--accent)]"
              : "text-[var(--fg-3)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          }`}
          title={inspectorOpen ? "收起检查器" : "展开检查器"}
          aria-label="检查器"
          aria-pressed={inspectorOpen}
        >
          <PanelRight className="h-[16px] w-[16px]" />
        </button>
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="grid h-8 w-8 place-items-center rounded-md text-[var(--fg-3)] transition-colors duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
            title="更多"
            aria-label="更多"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal className="h-[16px] w-[16px]" />
          </button>
          {menuOpen && (
            <>
              {/* 透明遮罩: 点击任意处关闭 */}
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-36 rounded-md border border-[var(--line)] bg-[var(--raise)] py-1 shadow-md">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    if (activeSessionId) stopSession(activeSessionId);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-label text-[var(--fg-2)] transition-colors duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
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
