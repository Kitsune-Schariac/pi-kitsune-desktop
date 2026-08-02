import { useSessionStore } from "../store/session";
import { Plus, X, Loader2 } from "lucide-react";

// 从 cwd 提取最后一段作为 tab 标签
function shortName(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

// 顶部多 session 标签栏: 切换/关闭/新建
export function SessionTabs({ onNew }: { onNew?: () => void }) {
  const sessionOrder = useSessionStore((s) => s.sessionOrder);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const stopSession = useSessionStore((s) => s.stopSession);

  return (
    <div className="flex items-center gap-1 border-b border-neutral-200 bg-white px-2">
      {sessionOrder.map((sid) => {
        const s = sessions[sid];
        if (!s) return null;
        return (
          <div
            key={sid}
            onClick={() => setActiveSession(sid)}
            className={`group flex items-center gap-2 rounded-t-lg px-3 py-2 text-sm cursor-pointer transition ${
              sid === activeSessionId
                ? "bg-neutral-100 text-neutral-900"
                : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
            }`}
          >
            <span className="max-w-[120px] truncate">{shortName(s.cwd)}</span>
            {s.isStreaming ? (
              <Loader2 className="h-3 w-3 animate-spin text-orange-500" />
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  stopSession(sid);
                }}
                className="text-neutral-300 opacity-0 transition hover:text-red-500 group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
      {onNew && (
        <button
          onClick={onNew}
          className="flex items-center justify-center rounded px-2 py-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
          title="新建会话"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}