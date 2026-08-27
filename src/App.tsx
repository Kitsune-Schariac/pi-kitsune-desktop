import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSessionStore } from "./store/session";
import { useProjectsStore } from "./store/projects";
import { MessageList } from "./components/MessageList";
import { InputBar } from "./components/InputBar";
import { Sidebar } from "./components/Sidebar";
import { EmptyState, ProjectCard } from "./components/EmptyState";
import { ChaosLoader } from "./components/ChaosLoader";
import { SettingsWindow } from "./components/settings/SettingsWindow";
import { GitSidebarPanel } from "./components/GitSidebarPanel";
import { FleetSidebarPanel } from "./components/FleetSidebarPanel";
import { SkillsPanel } from "./components/panels/SkillsPanel";
import { PackagesPanel } from "./components/panels/PackagesPanel";
import { NotificationToasts, UiRequestModal } from "./components/UiRequestModal";
import { QueueIndicator } from "./components/QueueIndicator";
import { useThemeStore } from "./store/theme";
import { useGitStore } from "./store/git";
import { useFleetStore, parseSessionUuid } from "./store/fleet";
import { useFleetStreamEntries } from "./hooks/useFleetStreamEntries";
import { Loader2, X, GitBranch, Radar } from "lucide-react";

export type PanelKind = "skills" | "packages" | "settings" | null;

export default function App() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const active = activeSessionId ? sessions[activeSessionId] : null;
  const stopSession = useSessionStore((s) => s.stopSession);
  const isSwitching = useSessionStore((s) => s.isSwitching);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const resolveUiRequest = useSessionStore((s) => s.resolveUiRequest);
  const notifications = useSessionStore((s) => s.notifications);
  const dismissNotification = useSessionStore((s) => s.dismissNotification);

  // Git 工作台: 药丸入口 + 右侧内嵌侧栏 (design 三; S5 起深度交互走侧栏内嵌视图切换, 无弹层 diff)
  // cwd 用单 selector 取字符串: sessions map 随消息流频繁变, cwd 字符串不变则不重渲染
  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.cwd : undefined;
  });
  const gitStatus = useGitStore((s) => (cwd ? s.statusByCwd[cwd] ?? null : null));
  const gitError = useGitStore((s) => (cwd ? s.errorByCwd[cwd] ?? null : null));
  const loadGitStatus = useGitStore((s) => s.loadStatus);
  // 舰队药丸: 本会话活动数 (stream running + 本会话 artifact running), 无会话退化全局 (design R6)
  const runs = useFleetStore((s) => s.runs);
  const fleetRunCount = runs.length;
  const sessionPath = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.sessionPath : null;
  });
  const currentUuid = useMemo(() => parseSessionUuid(sessionPath), [sessionPath]);
  const streamEntries = useFleetStreamEntries();
  const fleetActiveCount = useMemo(() => {
    const streamRunning = streamEntries.filter((e) => e.state === "running").length;
    if (!activeSessionId) {
      // 无活动会话 → 全局 artifact 活动数 (stream 无来源恒 0)
      return runs.filter((r) => r.active).length;
    }
    if (currentUuid === "") {
      // 主会话路径未就绪: stream 恒属本会话可计; artifact 归属无法判定, 宁漏勿误不计
      // (review SF3: 旧写法把全局 artifact 活动混入, 其他会话的活动会错误计入本会话药丸)
      return streamRunning;
    }
    const localArtifactActive = runs.filter(
      (r) => r.active && r.session_id === currentUuid,
    ).length;
    return streamRunning + localArtifactActive;
  }, [activeSessionId, currentUuid, streamEntries, runs]);
  const [gitSidebarOpen, setGitSidebarOpen] = useState(false);
  const [fleetSidebarOpen, setFleetSidebarOpen] = useState(false);

  const [panel, setPanel] = useState<PanelKind>(null);
  // 空状态: 项目选择器的选中值 (InputBar 发送时自动建会话用)
  const [emptyProject, setEmptyProject] = useState("");
  // 悬浮输入卡高度: 动态撑开消息区底部留白, 避免高输入框遮挡最后一条消息
  const [inputBarH, setInputBarH] = useState(0);
  // 启动即加载侧边栏数据 (无连接面板, 直接进主界面)
  useEffect(() => {
    loadProjects();
    // 主题皮肤系统: 拉皮肤列表 + 恢复持久化 + 应用当前主题 (模块级防重入)
    useThemeStore.getState().init();
  }, [loadProjects]);

  // 舰队药丸初始快照: App 挂载拉一次 runs 给药丸数据 (PRD R4: 后台 run 在 GUI 重启后仍可被发现)
  useEffect(() => {
    void useFleetStore.getState().refresh();
  }, []);

  // ToolCallCard 联动按钮 → fleet store panelRequest 递增 → 开舰队面板 + 关 Git (互斥让位)
  const fleetPanelRequest = useFleetStore((s) => s.panelRequest);
  useEffect(() => {
    if (fleetPanelRequest > 0) {
      setGitSidebarOpen(false);
      setFleetSidebarOpen(true);
    }
  }, [fleetPanelRequest]);

  // Git 状态拉取 (原 Sidebar 职责迁入): cwd 变化拉一次 (药丸常驻显示需要 status)。
  // diff 视图归侧栏内部管理, cwd 变化侧栏自行重置回 list (design 三-3.3), App 不再持有 diffTarget
  useEffect(() => {
    if (cwd) loadGitStatus(cwd);
  }, [cwd]);

  // 工作台状态药丸 (design 三-3.1): 会话区 header 右上常驻, 聚合多源摘要。本次只接 git,
  // 后续 trellis/analytics/fleet 摘要挂进同一药丸 (父任务挂载点统一决策)
  let gitPill: ReactNode = null;
  if (gitStatus === null && !gitError) {
    // 首次加载中 → 不渲染 (避免空骨架闪烁)
  } else if (gitError) {
    // 未装 git 等 → 整个药丸隐藏 (侧栏展开后侧栏内显示红字)
  } else if (gitStatus && !gitStatus.is_repo) {
    // 非 git 仓库 → 灰显, 仍可点击展开 (PRD: 安静降级不报错, 侧栏内有提示)
    gitPill = (
      <button
        onClick={() => { if (gitSidebarOpen) setGitSidebarOpen(false); else { setFleetSidebarOpen(false); setGitSidebarOpen(true); } }}
        className={`rounded-full border px-2.5 py-1 text-xs text-neutral-400 transition hover:text-neutral-600 ${
          gitSidebarOpen ? "border-neutral-300" : "border-neutral-200"
        }`}
        title="非 Git 仓库"
      >
        非 Git 仓库
      </button>
    );
  } else {
    const changeCount = gitStatus?.files.length ?? 0;
    gitPill = (
      <button
        onClick={() => { if (gitSidebarOpen) setGitSidebarOpen(false); else { setFleetSidebarOpen(false); setGitSidebarOpen(true); } }}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition tabular-nums ${
          gitSidebarOpen
            ? "border-[rgb(var(--primary-400))] text-[rgb(var(--primary-600))]"
            : "border-neutral-200 text-neutral-500 hover:text-neutral-700"
        }`}
        title={`分支 ${gitStatus?.branch ?? "—"} · ${changeCount} 个变更`}
      >
        <GitBranch className="h-3.5 w-3.5" />
        <span className="max-w-[120px] truncate">{gitStatus?.branch ?? "—"}</span>
        <span className="text-neutral-300">·</span>
        <span>{changeCount}</span>
      </button>
    );
  }

  // 舰队药丸入口: 有 artifact run 或本会话有 stream 条目就显示 (活动数>0 带数字, 0 仅入口看历史)
  let fleetPill: ReactNode = null;
  if (fleetRunCount > 0 || streamEntries.length > 0) {
    fleetPill = (
      <button
        onClick={() => { if (fleetSidebarOpen) setFleetSidebarOpen(false); else { setGitSidebarOpen(false); setFleetSidebarOpen(true); } }}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition tabular-nums ${
          fleetSidebarOpen
            ? "border-[rgb(var(--primary-400))] text-[rgb(var(--primary-600))]"
            : "border-neutral-200 text-neutral-500 hover:text-neutral-700"
        }`}
        title={fleetActiveCount > 0 ? `${fleetActiveCount} 个 subagent 活动中` : "查看 subagent 运行产物"}
      >
        <Radar className="h-3.5 w-3.5" />
        <span>舰队{fleetActiveCount > 0 ? ` ${fleetActiveCount}` : ""}</span>
      </button>
    );
  }

  return (
    <>
      {/* 背景层: 皮肤背景图铺这里 (自身 blur 模拟毛玻璃底, 不用 backdrop-filter — WebView2 大面积 backdrop-filter 有内容消失 bug)
          浅色时 --bg-image 为 none, 透出根容器渐变 */}
      <div
        className="app-bg fixed inset-0 z-0 bg-cover bg-center [background-image:var(--bg-image)] [filter:blur(var(--bg-blur))] [transform:scale(1.06)]"
        aria-hidden
      />
      <div
        id="app-root"
        className="fixed inset-0 flex overflow-hidden bg-gradient-to-b from-white to-primary-100 text-neutral-900"
      >
      <Sidebar onOpenPanel={setPanel} />
      {/* relative: 供底部悬浮输入框 absolute 定位
          不压缩滚动区: 消息可滑到输入卡后方 (半透明可见), 底部留白由 MessageList 内部 padding 承担 */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-[rgb(var(--surface-base)/var(--chat-alpha))] shadow-[-10px_0_24px_-12px_rgba(0,0,0,0.08)]">
        {isSwitching ? (
          <div className="flex flex-1 items-center justify-center">
            <ChaosLoader />
          </div>
        ) : active ? (
          <>
            <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">
                  {active.sessionName || active.cwd.split(/[\\/]/).filter(Boolean).pop()}
                </span>
                <span className="truncate text-xs text-neutral-500" title={active.cwd}>
                  {active.cwd}
                </span>
                {active.isStreaming && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    思考中
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {fleetPill}
                {gitPill}
                <QueueIndicator steering={active.steeringQueue} followUp={active.followUpQueue} />
                <button
                  onClick={() => stopSession(activeSessionId!)}
                  className="rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600"
                >
                  关闭会话
                </button>
              </div>
            </header>
            {/* 错误提示放 header 下方: 悬浮输入框会盖住底部区域, 放底部看不见 */}
            {active?.error && (
              <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-600">
                {active.error}
              </div>
            )}
            <MessageList inputBarH={inputBarH} />
          </>
        ) : (
          <EmptyState />
        )}
        <InputBar
          emptyProject={emptyProject}
          onHeightChange={setInputBarH}
          onOpenPanel={setPanel}
          bottomLayer={
            // 仅空状态: 项目选择卡片压在输入卡下层, 顶部露出可点击
            !active && <ProjectCard project={emptyProject} onProjectChange={setEmptyProject} />
          }
        />
      </main>

      {/* Git 侧栏: main 的 flex 兄弟 (展开时右让 340px, 收起恢复全宽, 由 flex 自然完成) */}
      {active && gitSidebarOpen && (
        <GitSidebarPanel cwd={active.cwd} onClose={() => setGitSidebarOpen(false)} />
      )}
      {active && fleetSidebarOpen && (
        <FleetSidebarPanel onClose={() => setFleetSidebarOpen(false)} />
      )}

      {/* 扩展 UI 请求弹窗: 只渲染活跃会话的队头请求 (FIFO, 关闭后自动弹下一个) */}
      {active && active.uiRequests.length > 0 && (
        <UiRequestModal
          request={active.uiRequests[0]}
          onResolve={(id, payload) => resolveUiRequest(activeSessionId!, id, payload)}
          onCancel={(id) => resolveUiRequest(activeSessionId!, id, { cancelled: true })}
        />
      )}

      {/* 扩展 notify 通知条 (fire-and-forget, 右下角自动消失) */}
      {notifications.length > 0 && (
        <NotificationToasts notifications={notifications} onDismiss={dismissNotification} />
      )}

      {/* 设置: 独立模态窗口 (与右侧 drawer 并存, 不冲突) */}
      {panel === "settings" && <SettingsWindow onClose={() => setPanel(null)} />}

      {/* 右侧面板抽屉 (Skill/package): settings 走独立模态窗, 不进抽屉, 否则多出空白抽屉 */}
      {(panel === "skills" || panel === "packages") && (
        <div className="absolute inset-0 z-40 flex justify-end bg-black/10">
          <div className="flex h-full w-[380px] flex-col border-l border-neutral-200 bg-panel shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
              <span className="font-medium">
                {panel === "skills" ? "Skill 管理" : "pi Package"}
              </span>
              <button
                onClick={() => setPanel(null)}
                className="rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {panel === "skills" && <SkillsPanel />}
              {panel === "packages" && <PackagesPanel />}
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}
