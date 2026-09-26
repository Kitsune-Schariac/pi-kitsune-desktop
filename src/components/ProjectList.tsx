import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useProjectsStore, pathEq, type SessionNode, type ProjectNode } from "../store/projects";
import { useSessionStore, type SessionState } from "../store/session";
import {
  ChevronRight, ChevronDown, Trash2, Plus,
  MessageSquare, FolderOpen, X,
} from "lucide-react";
import {
  abbr, hue, isTempProject, parseSessionTs, recentGroupLabel, formatRecentTime,
} from "../lib/projectGroups";

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
      className="fixed z-50 min-w-[160px] rounded-md border border-[var(--line)] bg-[var(--raise)] py-1 shadow-[var(--shadow)]"
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
              ? "text-[var(--err)] hover:bg-[color-mix(in_oklch,var(--err)_14%,transparent)]"
              : "text-[var(--fg)] hover:bg-[var(--hover)]"
          }`}
        >
          {item.icon && <item.icon className="h-4 w-4" />}
          {item.label}
        </button>
      ))}
    </div>
  );
}

// 文件名时间戳 (非标准 ISO, 见 parseSessionTs) → 本地 MM-DD; 解析失败原样返回
function formatTime(ts: string): string {
  const ms = parseSessionTs(ts);
  if (ms === null) return ts;
  const d = new Date(ms);
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

// 拍平条目 (搜索模式与最近视图共用): 磁盘会话 / 打开中且磁盘列表查不到的会话
type FlatHit =
  | { kind: "disk"; p: ProjectNode; s: SessionNode }
  | { kind: "open"; p: ProjectNode; sid: string; s: SessionState };

// 会话行 (树模式 + 拍平模式共用): 单行紧凑 (padding 5px 8px ≈ 27px 高), 无前置图标,
// 右侧状态三态 (工作中狐火 / 完成未读 accent 圆点 / 默认时间); 选中底色 ≠ 活跃。最近视图
// 前置项目徽标 (leading), 树模式不传。hover 删除钮绝对定位于右侧状态位之上, 行高零变化
function SessionRow({
  title,
  leading,
  hint,
  isActive,
  right,
  onOpen,
  onDelete,
  onContext,
}: {
  title: string;
  /** 前置徽标 (最近视图: 项目缩写圆形/圆角标; 项目树不传) */
  leading?: ReactNode;
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
      className={`sess-row group relative flex cursor-pointer items-center gap-2 rounded-md py-[5px] pl-2 pr-2 text-body transition duration-fast ease-out ${
        isActive
          ? "sel font-medium"
          : "text-[var(--fg-2)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
      }`}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e);
      }}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate group-hover:pr-6" title={hint ?? title}>
        {title}
      </span>
      {/* 右侧状态位: 常驻占位保布局稳定, hover 时淡出让位给删除钮 */}
      <span className="flex shrink-0 items-center justify-center pl-1 transition-opacity duration-fast ease-out group-hover:opacity-0">
        {right === "spinner" ? (
          // 运行中符号: 工坊狐火 / 舞台刻印环 (index.css 按 data-style 分支, 替代转圈图标)
          <span className="flame" aria-hidden />
        ) : right === "dot" ? (
          <span className="h-[5.5px] w-[5.5px] rounded-full bg-[var(--accent)] shadow-[0_0_5px_color-mix(in_oklch,var(--accent)_55%,transparent)]" />
        ) : right === null ? (
          <span className="text-mini text-[var(--fg-4)]">新会话</span>
        ) : (
          <span className="text-label tabular-nums text-[var(--fg-3)]">{right}</span>
        )}
      </span>
      {/* hover 浮现删除钮: 绝对定位在右侧状态位上方, 不进流式布局 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--fg-4)] opacity-0 transition duration-fast ease-out hover:text-[var(--err)] group-hover:opacity-100"
        title="删除会话"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

// 最近视图每页条数 (「显示更多」步长)
const RECENT_PAGE = 50;
// 临时目录组展开态持久化键 (默认折叠)
const TEMP_GROUP_KEY = "kitsune.tempGroupOpen";

// 项目条目: storeIndex = store 里的下标 (拖拽排序用), -1 = 虚拟项目 (仅承载打开中会话, 不可拖)
type ProjectEntry = { p: ProjectNode; storeIndex: number };

export function ProjectList({
  searchQuery = "",
  mode = "projects",
}: {
  searchQuery?: string;
  mode?: "recent" | "projects";
}) {
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
  const [recentLimit, setRecentLimit] = useState(RECENT_PAGE);
  const [tempOpen, setTempOpen] = useState(() => localStorage.getItem(TEMP_GROUP_KEY) === "1");

  if (!loaded) {
    return <div className="px-4 py-6 text-body text-[var(--fg-4)]">加载中…</div>;
  }
  if (error) {
    return (
      <div className="px-4 py-6 text-body text-[var(--fg-2)]">
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

  // 拍平数据源 (搜索与最近视图共用): 磁盘会话 + 打开中未落盘, 不搜索时不过滤
  const searching = searchQuery.trim() !== "";
  const q = searchQuery.trim().toLowerCase();
  const flatHits: FlatHit[] = displayProjects.flatMap((p) => {
    const projHit = searching && p.display_name.toLowerCase().includes(q);
    const disk = p.sessions
      .filter((s) => !searching || projHit || sessionTitle(s).toLowerCase().includes(q))
      .map((s) => ({ kind: "disk" as const, p, s }));
    const openOnly = openOnlySessions(p, sessionOrder, sessions)
      .filter(({ s }) => !searching || projHit || openSessionTitle(s).toLowerCase().includes(q))
      .map(({ sid, s }) => ({ kind: "open" as const, p, sid, s }));
    return [...disk, ...openOnly];
  });

  // 最近视图排序键: 打开中且磁盘列表查不到的会话视为最新 (未落盘 / 扫描未刷新),
  // 同一批内后打开的排前; 磁盘条目用文件 mtime, 缺失时回退文件名时间戳
  const recentRank = (h: FlatHit): number =>
    h.kind === "open"
      ? Number.MAX_SAFE_INTEGER + sessionOrder.indexOf(h.sid)
      : h.s.mtime_ms ?? parseSessionTs(h.s.timestamp) ?? 0;

  // 最近视图: 全量拍平 → 时间降序 → 按页截断 → 今天 / 本周 / 更早分组。
  // 先截断再分组, 保证「显示更多」展开的是全局下一段而不是某一组的尾巴
  const recentSorted =
    mode === "recent" && !searching ? [...flatHits].sort((a, b) => recentRank(b) - recentRank(a)) : [];
  const recentGroups: { label: string; items: FlatHit[] }[] = [];
  for (const h of recentSorted.slice(0, recentLimit)) {
    const label = recentGroupLabel(recentRank(h));
    const tail = recentGroups[recentGroups.length - 1];
    if (tail && tail.label === label) tail.items.push(h);
    else recentGroups.push({ label, items: [h] });
  }

  if (projects.length === 0 && uniqueVirtual.length === 0) {
    return (
      <div className="px-4 py-6 text-body text-[var(--fg-4)]">
        {mode === "recent" ? "还没有任何会话。在对话区开始第一段对话即可。" : "暂无项目。在对话区选择项目即可开始。"}
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

  /**
   * 拍平行渲染 (搜索模式与最近视图共用): 打开 / 删除 / 右键菜单与搜索模式完全一致,
   * 只多一个可选徽标与时间格式开关。提前把 union 判别成明确分支变量: 回调闭包内
   * TS 对 hit.kind 收窄不可靠 (沿用原搜索模式的写法)。
   */
  const renderFlatRow = (
    hit: FlatHit,
    opts?: { timeMode?: "date" | "recent"; badge?: ReactNode }
  ) => {
    const diskHit = hit.kind === "disk" ? hit : null;
    const openHit = hit.kind === "open" ? hit : null;
    const title = diskHit ? sessionTitle(diskHit.s) : openSessionTitle(openHit!.s);
    // 磁盘会话: 查它是否已在打开列表; 打开中会话: sid 本身
    const openId = diskHit
      ? sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, diskHit.s.session_path))
      : openHit!.sid;
    const isActive = openId === activeSessionId;
    const right: "spinner" | "dot" | string | null =
      openId && sessions[openId]?.isStreaming
        ? "spinner"
        : openId && sessions[openId]?.hasUnread
          ? "dot"
          : diskHit
            ? opts?.timeMode === "recent"
              ? formatRecentTime(recentRank(diskHit))
              : formatTime(diskHit.s.timestamp)
            : null;
    return (
      <SessionRow
        key={diskHit ? diskHit.s.session_path : `open:${openHit!.sid}`}
        leading={opts?.badge}
        title={title}
        hint={hit.p.display_name}
        isActive={isActive}
        right={right}
        onOpen={() =>
          diskHit ? handleOpenSession(diskHit.p.path, diskHit.s) : setActiveSession(openHit!.sid)
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
  };

  /**
   * 项目行渲染 (主列表与临时目录组共用): draggable 只在主列表为 true。
   * 虚拟项目 (storeIndex = -1) 与临时目录组的项目都不参与持久化排序。
   */
  const renderProjectNode = (entry: ProjectEntry, draggable: boolean) => {
    const { p, storeIndex } = entry;
    const isVirtual = storeIndex < 0;
    return (
      <div
        key={p.path}
        draggable={draggable}
        onDragStart={(e) => {
          if (!draggable) return;
          setDragIndex(storeIndex);
          e.dataTransfer.effectAllowed = "move";
        }}
        // 非拖拽区不 preventDefault: 浏览器不把它当有效放置目标, drop 不会落进来
        onDragOver={(e) => {
          if (!draggable) return;
          e.preventDefault();
        }}
        onDrop={(e) => {
          if (!draggable) return;
          e.preventDefault();
          if (dragIndex !== null && dragIndex !== storeIndex) moveProject(dragIndex, storeIndex);
          setDragIndex(null);
        }}
        className="mb-1"
      >
        {/* 项目行: hover 按钮绝对定位不参与流式布局 (0b31a75 防行高跳动的延续) */}
        <div
          className="group relative flex cursor-pointer items-center gap-2 rounded-md py-[5px] pl-2 pr-2 text-body transition duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
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
            <ChevronDown className="h-4 w-4 shrink-0 text-[var(--fg-3)] transition duration-fast ease-out group-hover:text-[var(--accent)]" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--fg-3)] transition duration-fast ease-out group-hover:text-[var(--accent)]" />
          )}
          <FolderOpen className="h-4 w-4 shrink-0 text-[var(--fg-3)] transition duration-fast ease-out group-hover:text-[var(--accent)]" />
          <span
            className="min-w-0 flex-1 truncate font-medium text-[var(--fg-2)] transition duration-fast ease-out group-hover:pr-8 group-hover:text-[var(--fg)]"
            title={p.path}
          >
            {p.display_name}
          </span>
          {/* 会话计数: hover 淡出让位给操作钮 */}
          <span className="shrink-0 pr-1 font-mono text-micro text-[var(--fg-4)] transition-opacity duration-fast ease-out group-hover:opacity-0">
            {p.sessions.length}
          </span>
          {/* 浮现操作钮 (绝对定位, 不撑高行) */}
          <span className="absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-1 group-hover:flex">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleNewSession(p.path);
              }}
              className="rounded p-1 text-[var(--fg-3)] transition duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
              title="新建会话"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                isVirtual ? stopAllCwdSessions(p.path) : removeProject(p.path);
              }}
              className="rounded p-1 text-[var(--fg-3)] transition duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--err)]"
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
                className="w-full rounded-md py-1 pl-2 text-left text-mini text-[var(--fg-3)] transition duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
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
  };

  // 项目树分两段: 主列表 (参与拖拽排序) + 底部「临时目录」折叠组 (不参与)
  const allEntries: ProjectEntry[] = [
    ...projects.map((p, storeIndex) => ({ p, storeIndex })),
    ...uniqueVirtual.map((p) => ({ p, storeIndex: -1 })),
  ];
  const mainEntries = allEntries.filter(({ p }) => !isTempProject(p.path, p.display_name));
  const tempEntries = allEntries.filter(({ p }) => isTempProject(p.path, p.display_name));

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {/* 搜索模式: 两种视图共用的平铺过滤结果 (不分组) */}
      {searching && (
        <div className="space-y-1 px-1 py-1">
          {flatHits.length === 0 ? (
            <div className="px-3 py-4 text-mini text-[var(--fg-4)]">无匹配会话</div>
          ) : (
            flatHits.map((hit) => renderFlatRow(hit))
          )}
        </div>
      )}

      {/* 最近视图 (design §6): 跨项目按修改时间降序, 今天 / 本周 / 更早分组, 单行 = 徽标 + 标题 + 三态 */}
      {!searching && mode === "recent" && (
        <div className="flex flex-col">
          {recentGroups.length === 0 ? (
            <div className="px-3 py-4 text-mini text-[var(--fg-4)]">暂无会话</div>
          ) : (
            recentGroups.map((g) => (
              <div key={g.label}>
                <div className="sess-grp">{g.label}</div>
                {g.items.map((h) =>
                  renderFlatRow(h, {
                    timeMode: "recent",
                    badge: (
                      <span
                        className="sess-badge"
                        // CSS 自定义属性 --h 不在 CSSProperties 类型定义内, 双重断言绕过
                        style={{ "--h": String(hue(h.p.display_name)) } as unknown as CSSProperties}
                        aria-hidden
                      >
                        {abbr(h.p.display_name)}
                      </span>
                    ),
                  }),
                )}
              </div>
            ))
          )}
          {recentSorted.length > recentLimit && (
            <button
              onClick={() => setRecentLimit((n) => n + RECENT_PAGE)}
              className="w-full rounded-md py-1 pl-2 text-left text-mini text-[var(--fg-3)] transition duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
            >
              显示更多 ({recentSorted.length - recentLimit})…
            </button>
          )}
        </div>
      )}

      {/* 项目视图: 主列表 + 临时目录组 */}
      {!searching && mode === "projects" && (
        <>
          {mainEntries.map((entry) => renderProjectNode(entry, entry.storeIndex >= 0))}
          {tempEntries.length > 0 && (
            // 临时目录组 (design §6): UUID / AppData 下的项目收进底部, 默认折叠, 展开态持久化
            <div className="mt-3 border-t border-dashed border-[var(--line-2)] pt-2">
              <button
                onClick={() => {
                  setTempOpen((v) => {
                    const next = !v;
                    try {
                      localStorage.setItem(TEMP_GROUP_KEY, next ? "1" : "0");
                    } catch { /* ignore */ }
                    return next;
                  });
                }}
                className="flex h-[30px] w-full cursor-pointer items-center gap-2 rounded-md px-2 text-body text-[var(--fg-3)] transition duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg-2)]"
                title="临时目录（自动收起，不参与排序）"
              >
                {tempOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-left text-[var(--fg-4)]">临时目录</span>
                <span className="shrink-0 pr-1 font-mono text-micro text-[var(--fg-4)]">
                  {tempEntries.length}
                </span>
              </button>
              {tempOpen && tempEntries.map((entry) => renderProjectNode(entry, false))}
            </div>
          )}
        </>
      )}

      {ctx && <ContextMenu {...ctx} onClose={() => setCtx(null)} />}

      {/* 重命名输入: 会话行内联编辑 */}
      {renamingPath && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20">
          <div className="w-72 rounded-md border border-[var(--line)] bg-[var(--raise)] p-4 shadow-[var(--shadow)]">
            <p className="mb-2 text-body font-semibold text-[var(--fg)]">重命名会话</p>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitRename()}
              className="w-full rounded-md border border-[var(--line-2)] bg-[var(--well)] px-3 py-2 text-body text-[var(--fg)] outline-none placeholder:text-[var(--fg-4)] focus:border-[var(--accent)]"
              placeholder="会话名称"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setRenamingPath(null)}
                className="rounded-md px-3 py-2 text-body text-[var(--fg-2)] transition duration-fast ease-out hover:bg-[var(--hover)]"
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
