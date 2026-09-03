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
      className="fixed z-50 min-w-[160px] rounded-md border border-[var(--border-soft)] bg-[var(--panel)] py-1 shadow-[var(--shadow-lg)]"
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
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-body transition duration-fast ease-out disabled:opacity-40 ${
            item.danger
              ? "text-[var(--danger)] hover:bg-[color-mix(in_oklch,var(--danger)_14%,transparent)]"
              : "text-[var(--fg)] hover:bg-[var(--sel-bg)]"
          }`}
        >
          {item.icon && <item.icon className="h-4 w-4" />}
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
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

// 会话行 (树模式 + 搜索拍平共用): 单行紧凑 (padding 5px 8px ≈ 27px 高), 无前置图标,
// 右侧状态三态 (工作中转圈 / 完成未读 accent 圆点 / 默认时间); 选中底色 ≠ 活跃, 无活跃徽标。
// hover 删除钮绝对定位于右侧状态位之上 (状态淡出、按钮浮入), 不参与流式布局 → 行高零变化
function SessionRow({
  title,
  hint,
  isActive,
  right,
  onOpen,
  onDelete,
  onContext,
}: {
  title: string;
  /** hover 提示 (搜索模式显示所属项目) */
  hint?: string;
  isActive: boolean;
  /** 右侧状态位: "spinner" 工作中 / "dot" 完成未读 / 时间字符串 / null 无 (新会话显示弱字) */
  right: "spinner" | "dot" | string | null;
  onOpen: () => void;
  onDelete: () => void;
  /** 右键菜单: 传出原生事件供定位 */
  onContext: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`group relative flex cursor-pointer items-center rounded-md py-[5px] pl-2 pr-2 text-body transition duration-fast ease-out ${
        isActive
          ? "bg-[var(--sel-bg)] font-medium text-[var(--fg)]"
          : "text-[var(--muted)] hover:bg-[color-mix(in_oklch,var(--surface-2)_65%,transparent)] hover:text-[var(--fg)]"
      }`}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e);
      }}
    >
      <span className="min-w-0 flex-1 truncate group-hover:pr-6" title={hint ?? title}>
        {title}
      </span>
      {/* 右侧状态位: 常驻占位保布局稳定, hover 时淡出让位给删除钮 */}
      <span className="shrink-0 pl-1 transition-opacity duration-fast ease-out group-hover:opacity-0">
        {right === "spinner" ? (
          <Loader2 className="h-3 w-3 animate-spin text-[var(--accent)]" />
        ) : right === "dot" ? (
          <span className="h-[5.5px] w-[5.5px] rounded-full bg-[var(--accent)] shadow-[0_0_5px_color-mix(in_oklch,var(--accent)_55%,transparent)]" />
        ) : right === null ? (
          <span className="text-mini text-[var(--faint)]">新会话</span>
        ) : (
          <span className="text-label tabular-nums text-[var(--muted)]">{right}</span>
        )}
      </span>
      {/* hover 浮现删除钮: 绝对定位在右侧状态位上方, 不进流式布局 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--faint)] opacity-0 transition duration-fast ease-out hover:text-red-500 group-hover:opacity-100"
        title="删除会话"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

export function ProjectList({ searchQuery = "" }: { searchQuery?: string }) {
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
  const reattachSession = useSessionStore((s) => s.reattachSession);
  const removeSessionState = useSessionStore((s) => s.removeSessionState);
  const renameSession = useSessionStore((s) => s.renameSession);

  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [startingPath, setStartingPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  if (!loaded) {
    return <div className="px-4 py-6 text-body text-[var(--faint)]">加载中…</div>;
  }
  if (error) {
    return (
      <div className="px-4 py-6 text-body text-[var(--muted)]">
        <p>{error}</p>
        <button onClick={loadProjects} className="mt-2 text-[var(--accent)] hover:underline">
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

  // 搜索模式: 跨项目拍平所有会话 (磁盘 + 未落盘), 按标题/项目名包含过滤, 不按项目分组。
  // 数据源与树模式同一批 (projects + virtual + openOnly), 不引入设计稿假数据
  const searching = searchQuery.trim() !== "";
  const q = searchQuery.trim().toLowerCase();
  const flatHits = searching
    ? displayProjects.flatMap((p) => {
        const projHit = p.display_name.toLowerCase().includes(q);
        const disk = p.sessions
          .filter((s) => projHit || sessionTitle(s).toLowerCase().includes(q))
          .map((s) => ({ kind: "disk" as const, p, s }));
        const openOnly = openOnlySessions(p, sessionOrder, sessions)
          .filter(({ s }) => projHit || openSessionTitle(s).toLowerCase().includes(q))
          .map(({ sid, s }) => ({ kind: "open" as const, p, sid, s }));
        return [...disk, ...openOnly];
      })
    : [];

  if (projects.length === 0 && uniqueVirtual.length === 0) {
    return (
      <div className="px-4 py-6 text-body text-[var(--faint)]">
        暂无项目。在对话区选择项目即可开始。
      </div>
    );
  }

  // 移除虚拟项目 = 关闭该 cwd 下全部打开会话 (无磁盘记录可删, 会话关完项目自然消失)
  const stopAllCwdSessions = (cwd: string) => {
    // 移除项目 = 关掉该 cwd 全部打开会话: 停进程 + 真删 state (不然 detached 会留在侧边栏)
    sessionOrder.filter((sid) => sessions[sid]?.cwd === cwd).forEach((sid) => {
      stopSession(sid);
      removeSessionState(sid);
    });
  };

  // 点击会话: 已打开 → 切换; 未打开 → 加载历史
  // openId 对账用 pathEq: pi 返回的 sessionFile 与磁盘扫描路径可能大小写/分隔符不一致
  const handleOpenSession = async (projectPath: string, s: SessionNode) => {
    const openId = sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, s.session_path));
    if (openId) {
      // 快路径: 同步切换 + 渲染缓存 entries (即使 detached 也先显示), detached 时后台 reattach
      setActiveSession(openId);
      if (sessions[openId]?.detached) {
        void reattachSession(openId, projectPath, s.session_path);
      }
      return;
    }
    // 慢路径: 无缓存首次打开 (UI 立即切 + loading 占位, 不阻塞 await)
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
    if (openId) {
      await stopSession(openId); // 停进程 + detach
      removeSessionState(openId); // 真删 state (磁盘文件要删, detached entries 留着无意义)
    }
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
      {/* 搜索模式: 平铺过滤结果 */}
      {searching && (
        <div className="space-y-1 px-1 py-1">
          {flatHits.length === 0 ? (
            <div className="px-3 py-4 text-mini text-[var(--faint)]">无匹配会话</div>
          ) : (
            flatHits.map((hit) => {
              // 提前把 union 判别成明确分支变量: 回调闭包内 TS 对 hit.kind 收窄不可靠
              const diskHit = hit.kind === "disk" ? hit : null;
              const openHit = hit.kind === "open" ? hit : null;
              const title = diskHit ? sessionTitle(diskHit.s) : openSessionTitle(openHit!.s);
              const sessionPath = diskHit ? diskHit.s.session_path : null;
              const openIdOf = diskHit
                ? sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, sessionPath))
                : undefined;
              const isActive = diskHit
                ? openIdOf === activeSessionId
                : openHit!.sid === activeSessionId;
              const right: "spinner" | "dot" | string | null = diskHit
                ? openIdOf && sessions[openIdOf]?.isStreaming
                  ? "spinner"
                  : openIdOf && sessions[openIdOf]?.hasUnread
                    ? "dot"
                    : formatTime(diskHit.s.timestamp)
                : openHit!.s.isStreaming
                  ? "spinner"
                  : openHit!.s.hasUnread
                    ? "dot"
                    : null;
              return (
                <SessionRow
                  key={diskHit ? diskHit.s.session_path : `open:${openHit!.sid}`}
                  title={title}
                  hint={hit.p.display_name}
                  isActive={isActive}
                  right={right}
                  onOpen={() =>
                    diskHit
                      ? handleOpenSession(diskHit.p.path, diskHit.s)
                      : setActiveSession(openHit!.sid)
                  }
                  onDelete={() =>
                    diskHit
                      ? handleDeleteSession(diskHit.p.path, diskHit.s)
                      : (stopSession(openHit!.sid), removeSessionState(openHit!.sid))
                  }
                  onContext={(e) => {
                    if (diskHit) {
                      const open = sessionOrder.find((sid) =>
                        pathEq(sessions[sid]?.sessionPath, diskHit.s.session_path),
                      );
                      setCtx({
                        x: e.clientX, y: e.clientY,
                        items: [
                          { label: "打开", icon: FolderOpen, onClick: () => handleOpenSession(diskHit.p.path, diskHit.s) },
                          {
                            label: "重命名",
                            icon: MessageSquare,
                            disabled: !open,
                            onClick: () => {
                              setRenamingPath(diskHit.s.session_path);
                              setRenameValue(sessionTitle(diskHit.s));
                            },
                          },
                          {
                            label: "删除会话",
                            icon: Trash2,
                            danger: true,
                            onClick: () => handleDeleteSession(diskHit.p.path, diskHit.s),
                          },
                        ],
                      });
                    } else {
                      const o = openHit!;
                      setCtx({
                        x: e.clientX, y: e.clientY,
                        items: [
                          { label: "打开", icon: FolderOpen, onClick: () => setActiveSession(o.sid) },
                          {
                            label: "删除会话",
                            icon: Trash2,
                            danger: true,
                            onClick: () => {
                              stopSession(o.sid);
                              removeSessionState(o.sid);
                            },
                          },
                        ],
                      });
                    }
                  }}
                />
              );
            })
          )}
        </div>
      )}

      {/* 树模式 */}
      {!searching && displayProjects.map((p, index) => {
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
          className="mb-1"
        >
          {/* 项目行: hover 按钮绝对定位不参与流式布局 (0b31a75 防行高跳动的延续) */}
          <div
            className="group relative flex cursor-pointer items-center gap-2 rounded-md py-[5px] pl-2 pr-2 text-body transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--surface-2)_55%,transparent)] hover:text-[var(--fg)]"
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
              <ChevronDown className="h-4 w-4 shrink-0 text-[var(--faint)] transition duration-fast ease-out group-hover:text-[var(--accent)]" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--faint)] transition duration-fast ease-out group-hover:text-[var(--accent)]" />
            )}
            <FolderOpen className="h-4 w-4 shrink-0 text-[var(--faint)] transition duration-fast ease-out group-hover:text-[var(--accent)]" />
            <span
              className="min-w-0 flex-1 truncate font-medium text-[var(--muted)] transition duration-fast ease-out group-hover:pr-8 group-hover:text-[var(--fg)]"
              title={p.path}
            >
              {p.display_name}
            </span>
            {/* 会话计数: hover 淡出让位给操作钮 */}
            <span className="shrink-0 pr-1 font-mono text-micro text-[var(--faint)] transition-opacity duration-fast ease-out group-hover:opacity-0">
              {p.sessions.length}
            </span>
            {/* 浮现操作钮 (绝对定位, 不撑高行) */}
            <span className="absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-1 group-hover:flex">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleNewSession(p.path);
                }}
                className="rounded p-1 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
                title="新建会话"
              >
                <Plus className="h-3 w-3" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  isVirtual ? stopAllCwdSessions(p.path) : removeProject(p.path);
                }}
                className="rounded p-1 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-red-500"
                title="移除项目"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>

          {/* 会话列表: 最近 5 个, 点省略号每次 +7 */}
          {p.expanded && (
            <div className="ml-4 pl-2">
              {p.sessions.slice(0, p.visibleCount).map((s) => {
                const openId = sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, s.session_path));
                const isActive = openId === activeSessionId;
                const isLoading = startingPath === s.session_path;
                const right: "spinner" | "dot" | string | null = isLoading || (openId && sessions[openId]?.isStreaming)
                  ? "spinner"
                  : openId && sessions[openId]?.hasUnread
                    ? "dot"
                    : formatTime(s.timestamp);
                return (
                  <SessionRow
                    key={s.session_path}
                    title={sessionTitle(s)}
                    isActive={isActive}
                    right={right}
                    onOpen={() => handleOpenSession(p.path, s)}
                    onDelete={() => handleDeleteSession(p.path, s)}
                    onContext={(e) => {
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
                  />
                );
              })}
              {p.sessions.length > p.visibleCount && (
                <button
                  onClick={() => loadMore(p.path)}
                  className="w-full rounded-md py-1 pl-2 text-left text-mini text-[var(--muted)] transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--surface-2)_55%,transparent)] hover:text-[var(--fg)]"
                >
                  显示更多 ({p.sessions.length - p.visibleCount})…
                </button>
              )}
              {/* 打开中但磁盘列表没有的会话 (新会话未落盘 / 已落盘未刷新): 直接可点回 */}
              {openOnlySessions(p, sessionOrder, sessions).map(({ sid, s }) => (
                <SessionRow
                  key={`open:${sid}`}
                  title={openSessionTitle(s)}
                  isActive={sid === activeSessionId}
                  right={s.isStreaming ? "spinner" : s.hasUnread ? "dot" : null}
                  onOpen={() => setActiveSession(sid)}
                  onDelete={() => {
                    stopSession(sid);
                    removeSessionState(sid);
                  }}
                  onContext={(e) => {
                    setCtx({
                      x: e.clientX, y: e.clientY,
                      items: [
                        { label: "打开", icon: FolderOpen, onClick: () => setActiveSession(sid) },
                        {
                          label: "删除会话",
                          icon: Trash2,
                          danger: true,
                          onClick: () => {
                            stopSession(sid);
                            removeSessionState(sid);
                          },
                        },
                      ],
                    });
                  }}
                />
              ))}
            </div>
          )}
        </div>
        );
      })}

      {ctx && <ContextMenu {...ctx} onClose={() => setCtx(null)} />}

      {/* 重命名输入: 会话行内联编辑 */}
      {renamingPath && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20">
          <div className="w-72 rounded-md border border-[var(--border-soft)] bg-[var(--panel)] p-4 shadow-[var(--shadow-lg)]">
            <p className="mb-2 text-body font-semibold text-[var(--fg)]">重命名会话</p>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitRename()}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-base)] px-3 py-2 text-body text-[var(--fg)] outline-none placeholder:text-[var(--faint)] focus:border-[var(--accent)]"
              placeholder="会话名称"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setRenamingPath(null)}
                className="rounded-md px-3 py-2 text-body text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)]"
              >
                取消
              </button>
              <button
                onClick={submitRename}
                className="rounded-md bg-[var(--accent)] px-3 py-2 text-body font-semibold text-[var(--on-accent)] transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--accent)_88%,black)]"
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
