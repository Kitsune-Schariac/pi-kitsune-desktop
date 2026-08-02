import { useEffect, useState } from "react";
import { useProjectsStore, type SessionNode } from "../store/projects";
import { useSessionStore } from "../store/session";
import {
  ChevronRight, ChevronDown, Trash2, Plus,
  Loader2, MessageSquare, FolderOpen, X,
} from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: typeof Plus;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

// 通用右键菜单: fixed 定位, 点击外部 / ESC 关闭, 视口边缘自动回弹
export function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number; items: MenuItem[]; onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  // 视口边缘回弹: 菜单约 160px 宽
  const left = Math.min(x, window.innerWidth - 170);
  const top = Math.min(y, window.innerHeight - items.length * 36 - 16);

  return (
    <div
      className="fixed z-50 min-w-[160px] rounded-lg border border-neutral-200 bg-white py-1 shadow-xl"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          disabled={item.disabled}
          onClick={() => {
            if (!item.disabled) item.onClick();
            onClose();
          }}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition disabled:opacity-40 ${
            item.danger
              ? "text-red-600 hover:bg-red-50"
              : "text-neutral-700 hover:bg-neutral-100"
          }`}
        >
          {item.icon && <item.icon className="h-3.5 w-3.5" />}
          {item.label}
        </button>
      ))}
    </div>
  );
}

// 文件名时间戳 → 本地时间字符串 (文件名格式 2026-08-02T12-43-11-490Z, 非标准 ISO, 需转换)
function formatTime(ts: string): string {
  const iso = ts
    .replace(/-\d{3}Z$/, (m) => m.replace("-", "."))
    .replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1T$2:$3:$4");
  const d = new Date(iso);
  if (isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 会话行标题: preview 首行优先, 回退时间
function sessionTitle(s: SessionNode): string {
  const first = s.preview.split("\n")[0].trim();
  return first || s.file_name;
}

export function ProjectList() {
  const projects = useProjectsStore((s) => s.projects);
  const loaded = useProjectsStore((s) => s.loaded);
  const error = useProjectsStore((s) => s.error);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const toggleProject = useProjectsStore((s) => s.toggleProject);
  const loadMore = useProjectsStore((s) => s.loadMore);
  const removeProject = useProjectsStore((s) => s.removeProject);
  const removeSession = useProjectsStore((s) => s.removeSession);
  const moveProject = useProjectsStore((s) => s.moveProject);

  const sessions = useSessionStore((s) => s.sessions);
  const sessionOrder = useSessionStore((s) => s.sessionOrder);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const startSession = useSessionStore((s) => s.startSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const stopSession = useSessionStore((s) => s.stopSession);
  const renameSession = useSessionStore((s) => s.renameSession);

  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [startingPath, setStartingPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  if (!loaded) {
    return <div className="px-4 py-6 text-sm text-neutral-400">加载中…</div>;
  }
  if (error) {
    return (
      <div className="px-4 py-6 text-sm text-neutral-500">
        <p>{error}</p>
        <button onClick={loadProjects} className="mt-2 text-orange-500 hover:underline">
          重试
        </button>
      </div>
    );
  }
  if (projects.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-neutral-400">
        暂无项目。在对话区选择项目即可开始。
      </div>
    );
  }

  // 点击会话: 已打开 → 切换; 未打开 → 加载历史
  const handleOpenSession = async (projectPath: string, s: SessionNode) => {
    const openId = sessionOrder.find((sid) => sessions[sid]?.sessionPath === s.session_path);
    if (openId) {
      setActiveSession(openId);
      return;
    }
    setStartingPath(s.session_path);
    try {
      await startSession(projectPath, { sessionPath: s.session_path });
    } catch (e) {
      console.error("加载会话失败", e);
    }
    setStartingPath(null);
  };

  const handleNewSession = async (projectPath: string) => {
    setStartingPath(projectPath);
    try {
      await startSession(projectPath);
    } catch (e) {
      console.error("新建会话失败", e);
    }
    setStartingPath(null);
  };

  // 删除会话: 若正在使用则先停 runtime, 再删文件
  const handleDeleteSession = async (projectPath: string, s: SessionNode) => {
    const openId = sessionOrder.find((sid) => sessions[sid]?.sessionPath === s.session_path);
    if (openId) await stopSession(openId);
    await removeSession(projectPath, s.session_path);
  };

  // 重命名: 仅对已打开的会话生效 (走 pi RPC set_session_name)
  const submitRename = async () => {
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    const openId = sessionOrder.find((sid) => sessions[sid]?.sessionPath === renamingPath);
    if (openId) await renameSession(openId, renameValue.trim());
    setRenamingPath(null);
  };

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {projects.map((p, index) => (
        <div
          key={p.path}
          draggable
          onDragStart={(e) => {
            setDragIndex(index);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (dragIndex !== null && dragIndex !== index) moveProject(dragIndex, index);
            setDragIndex(null);
          }}
          className="mb-0.5"
        >
          {/* 项目行 */}
          <div
            className="group flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 transition hover:bg-neutral-200/60"
            onClick={() => toggleProject(p.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({
                x: e.clientX, y: e.clientY,
                items: [
                  { label: "新建会话", icon: Plus, onClick: () => handleNewSession(p.path) },
                  { label: "移除项目", icon: X, danger: true, onClick: () => removeProject(p.path) },
                ],
              });
            }}
          >
            {p.expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            )}
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-orange-400" />
            <span className="min-w-0 flex-1 truncate text-sm text-neutral-700" title={p.path}>
              {p.display_name}
            </span>
            <span className="text-[10px] text-neutral-400">{p.sessions.length}</span>
            <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
              <button
                onClick={(e) => { e.stopPropagation(); handleNewSession(p.path); }}
                className="rounded p-0.5 text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-700"
                title="新建会话"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); removeProject(p.path); }}
                className="rounded p-0.5 text-neutral-400 transition hover:bg-neutral-200 hover:text-red-500"
                title="移除项目"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>

          {/* 会话列表: 最近 5 个, 点省略号每次 +7 */}
          {p.expanded && (
            <div className="ml-4 border-l border-neutral-200 pl-2">
              {p.sessions.slice(0, p.visibleCount).map((s) => {
                const openId = sessionOrder.find((sid) => sessions[sid]?.sessionPath === s.session_path);
                const isActive = openId === activeSessionId;
                const isLoading = startingPath === s.session_path;
                return (
                  <div
                    key={s.session_path}
                    className={`group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-1.5 pr-1 text-sm transition ${
                      isActive
                        ? "bg-orange-100 text-orange-700"
                        : "text-neutral-600 hover:bg-neutral-200/60"
                    }`}
                    onClick={() => handleOpenSession(p.path, s)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const open = sessionOrder.find((sid) => sessions[sid]?.sessionPath === s.session_path);
                      setCtx({
                        x: e.clientX, y: e.clientY,
                        items: [
                          { label: "打开", icon: FolderOpen, onClick: () => handleOpenSession(p.path, s) },
                          {
                            label: "重命名",
                            icon: MessageSquare,
                            disabled: !open,
                            onClick: () => { setRenamingPath(s.session_path); setRenameValue(sessionTitle(s)); },
                          },
                          { label: "删除会话", icon: Trash2, danger: true, onClick: () => handleDeleteSession(p.path, s) },
                        ],
                      });
                    }}
                  >
                    {isLoading ? (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-orange-400" />
                    ) : openId ? (
                      <MessageSquare className="h-3 w-3 shrink-0 text-orange-400" />
                    ) : (
                      <MessageSquare className="h-3 w-3 shrink-0 text-neutral-300" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{sessionTitle(s)}</span>
                    <span className="shrink-0 text-[10px] text-neutral-400">{formatTime(s.timestamp)}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteSession(p.path, s); }}
                      className="hidden shrink-0 rounded p-0.5 text-neutral-400 transition hover:text-red-500 group-hover:block"
                      title="删除会话"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
              {p.sessions.length > p.visibleCount && (
                <button
                  onClick={() => loadMore(p.path)}
                  className="w-full rounded-md py-1 pl-1.5 text-left text-xs text-neutral-400 transition hover:bg-neutral-200/60 hover:text-neutral-600"
                >
                  显示更多 ({p.sessions.length - p.visibleCount})…
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {ctx && <ContextMenu {...ctx} onClose={() => setCtx(null)} />}

      {/* 重命名输入: 会话行内联编辑 */}
      {renamingPath && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-neutral-900/20">
          <div className="w-72 rounded-xl border border-neutral-200 bg-white p-4 shadow-2xl">
            <p className="mb-2 text-sm font-medium">重命名会话</p>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitRename()}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-orange-400"
              placeholder="会话名称"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setRenamingPath(null)}
                className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 transition hover:bg-neutral-100"
              >
                取消
              </button>
              <button
                onClick={submitRename}
                className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-orange-600"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
