import { useEffect, useState } from "react";
import { useProjectsStore, pathEq, type SessionNode, type ProjectNode } from "../store/projects";
import { useSessionStore, type SessionState } from "../store/session";
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

// 打开中会话 (磁盘尚无记录) 的标题: 第一条 user 消息截断, 还没发过消息显示"新会话"
function openSessionTitle(s: SessionState): string {
  const first = s.entries.find((e) => e.kind === "message" && e.role === "user")?.text?.trim();
  return (first ? first.slice(0, 40) : "新会话") || "新会话";
}

// 打开中但磁盘会话列表里没有的会话: 按 cwd 挂到对应项目下 (新会话未落盘 / 已落盘未刷新)
// 对账用 pathEq (Windows 路径大小写不敏感, pi 与磁盘扫描路径字符串可能不一致)
function openOnlySessions(
  p: { path: string; sessions: SessionNode[] },
  sessionOrder: string[],
  sessions: Record<string, SessionState>
): { sid: string; s: SessionState }[] {
  return sessionOrder
    .map((sid) => ({ sid, s: sessions[sid] }))
    .filter((x): x is { sid: string; s: SessionState } => !!x.s && x.s.cwd === p.path)
    .filter((x) => !x.s.sessionPath || !p.sessions.some((ds) => pathEq(ds.session_path, x.s.sessionPath)));
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

  // 打开中的会话可能属于磁盘上还不存在会话文件的项目 (首次在该目录新建会话):
  // 注入虚拟项目行, 否则新会话在侧边栏无处可挂 (必须在空判断前计算, 否则全空时看不到新会话)
  const virtualProjects: ProjectNode[] = sessionOrder
    .map((sid) => sessions[sid])
    .filter((s): s is SessionState => !!s)
    .filter((s) => !projects.some((p) => pathEq(p.path, s.cwd)))
    .map((s) => ({
      path: s.cwd,
      display_name: s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd,
      expanded: true,
      visibleCount: 5,
      removed: false,
      sessions: [],
    }));
  // 同一 cwd 多个会话只注入一个虚拟项目
  const seenCwd = new Set<string>();
  const uniqueVirtual = virtualProjects.filter((v) => {
    const k = v.path.toLowerCase();
    if (seenCwd.has(k)) return false;
    seenCwd.add(k);
    return true;
  });
  // 磁盘项目在前, 虚拟项目追加在后 (虚拟项目不参与持久化顺序/拖拽)
  const displayProjects = [...projects, ...uniqueVirtual];

  if (projects.length === 0 && uniqueVirtual.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-neutral-400">
        暂无项目。在对话区选择项目即可开始。
      </div>
    );
  }

  // 移除虚拟项目 = 关闭该 cwd 下全部打开会话 (无磁盘记录可删, 会话关完项目自然消失)
  const stopAllCwdSessions = (cwd: string) => {
    sessionOrder.filter((sid) => sessions[sid]?.cwd === cwd).forEach((sid) => stopSession(sid));
  };

  // 点击会话: 已打开 → 切换; 未打开 → 加载历史
  // openId 对账用 pathEq: pi 返回的 sessionFile 与磁盘扫描路径可能大小写/分隔符不一致
  const handleOpenSession = async (projectPath: string, s: SessionNode) => {
    const openId = sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, s.session_path));
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
    const openId = sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, s.session_path));
    if (openId) await stopSession(openId);
    await removeSession(projectPath, s.session_path);
  };

  // 重命名: 仅对已打开的会话生效 (走 pi RPC set_session_name)
  const submitRename = async () => {
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    const openId = sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, renamingPath));
    if (openId) await renameSession(openId, renameValue.trim());
    setRenamingPath(null);
  };

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {displayProjects.map((p, index) => {
        // 虚拟项目 (磁盘无记录, 只承载打开中的会话): 不可拖拽, 移除 = 关闭该 cwd 全部会话
        const isVirtual = index >= projects.length;
        return (
        <div
          key={p.path}
          draggable={!isVirtual}
          onDragStart={(e) => {
            if (isVirtual) return; // 虚拟项目不参与持久化排序
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
                items: isVirtual
                  ? [
                      { label: "新建会话", icon: Plus, onClick: () => handleNewSession(p.path) },
                      { label: "移除项目", icon: X, danger: true, onClick: () => stopAllCwdSessions(p.path) },
                    ]
                  : [
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
                onClick={(e) => { e.stopPropagation(); isVirtual ? stopAllCwdSessions(p.path) : removeProject(p.path); }}
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
                const openId = sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, s.session_path));
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
                      const open = sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, s.session_path));
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
              {/* 打开中但磁盘列表没有的会话 (新会话未落盘 / 已落盘未刷新): 直接可点回 */}
              {openOnlySessions(p, sessionOrder, sessions).map(({ sid, s }) => {
                const isActive = sid === activeSessionId;
                return (
                  <div
                    key={`open:${sid}`}
                    className={`group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-1.5 pr-1 text-sm transition ${
                      isActive
                        ? "bg-orange-100 text-orange-700"
                        : "text-neutral-600 hover:bg-neutral-200/60"
                    }`}
                    onClick={() => setActiveSession(sid)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtx({
                        x: e.clientX, y: e.clientY,
                        items: [
                          { label: "打开", icon: FolderOpen, onClick: () => setActiveSession(sid) },
                          { label: "删除会话", icon: Trash2, danger: true, onClick: () => stopSession(sid) },
                        ],
                      });
                    }}
                  >
                    <MessageSquare className="h-3 w-3 shrink-0 text-orange-400" />
                    <span className="min-w-0 flex-1 truncate">{openSessionTitle(s)}</span>
                    <span className="shrink-0 text-[10px] text-neutral-400">新会话</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); stopSession(sid); }}
                      className="hidden shrink-0 rounded p-0.5 text-neutral-400 transition hover:text-red-500 group-hover:block"
                      title="删除会话"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        );
      })}

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
