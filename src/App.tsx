import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSessionStore } from "./store/session";
import { useProjectsStore } from "./store/projects";
import { MessageList } from "./components/MessageList";
import { InputBar } from "./components/InputBar";
import { Sidebar } from "./components/Sidebar";
import { EmptyState, ProjectCard } from "./components/EmptyState";
import { ChaosLoader } from "./components/ChaosLoader";
import { TitleBar } from "./components/TitleBar";
import { SettingsWindow } from "./components/settings/SettingsWindow";
import { GitSidebarPanel } from "./components/GitSidebarPanel";
import { FleetSidebarPanel } from "./components/FleetSidebarPanel";
import { TrellisSidebarPanel } from "./components/TrellisSidebarPanel";
import { RightPanel } from "./components/RightPanel";
import { SkillsPanel } from "./components/panels/SkillsPanel";
import { PackagesPanel } from "./components/panels/PackagesPanel";
import { NotificationToasts, UiRequestModal } from "./components/UiRequestModal";
import { QueueIndicator } from "./components/QueueIndicator";
import { useThemeStore } from "./store/theme";
import { useGitStore } from "./store/git";
import { useFleetStore, parseSessionUuid } from "./store/fleet";
import { useFleetStreamEntries } from "./hooks/useFleetStreamEntries";
import { useTrellisTasksStore } from "./store/trellisTasks";
import { Loader2, X, GitBranch, Radar, ListTree } from "lucide-react";

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
  // 右侧面板单一 state (改版稿): 舰队/Trellis/Git 三入口共用, 同时只显一个; null = 收起。
  // 与左侧 drawer (panel) / 设置窗互不干扰。
  const [rightPanel, setRightPanel] = useState<"fleet" | "trellis" | "git" | null>(null);
  const toggleRightPanel = (kind: "fleet" | "trellis" | "git") => {
    setRightPanel((cur) => (cur === kind ? null : kind));
  };

  // 侧栏折叠 (改版稿): 收起后只剩窄条图标栏; 持久化, 重启保持
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("kitsune.sidebarCollapsed") === "1",
  );
  const toggleSidebar = () => {
    setSidebarCollapsed((c) => {
      localStorage.setItem("kitsune.sidebarCollapsed", c ? "0" : "1");
      return !c;
    });
  };

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

  // ToolCallCard 联动按钮 → fleet store panelRequest 递增 → 开舰队面板 (互斥让位由单一 state 保证)
  const fleetPanelRequest = useFleetStore((s) => s.panelRequest);
  useEffect(() => {
    if (fleetPanelRequest > 0) setRightPanel("fleet");
  }, [fleetPanelRequest]);

  // Git 状态拉取 (原 Sidebar 职责迁入): cwd 变化拉一次 (药丸常驻显示需要 status)。
  // diff 视图归侧栏内部管理, cwd 变化侧栏自行重置回 list (design 三-3.3), App 不再持有 diffTarget
  useEffect(() => {
    if (cwd) loadGitStatus(cwd);
  }, [cwd]);

  // Trellis 任务快照: cwd 变化拉一次, 主要服务于药丸显隐探测 (exists 判据, design §2 挂载)。
  // 无 .trellis 的项目 exists=false → 药丸不显示 (R3 安静降级); 面板打开时面板内还会再拉刷新
  const trellisExists = useTrellisTasksStore((s) => s.exists);
  const loadTrellisTasks = useTrellisTasksStore((s) => s.load);
  useEffect(() => {
    if (cwd) loadTrellisTasks(cwd);
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // 工作台状态药丸 (改版稿 .ct-pill): 会话区 header 右上常驻, 聚合多源摘要。
  // on 态 (面板开着) = accent 边框 + accent 字 + accent-soft 底; off = border-soft + muted,
  // hover 变 fg。触发互斥由单一 rightPanel state 保证 (toggleRightPanel)。
  const pillOn = "border-[color-mix(in_oklch,var(--accent)_45%,transparent)] text-[var(--accent)] bg-[var(--accent-soft)]";
  const pillOff = "border-[var(--border-soft)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--border)]";
  let gitPill: ReactNode = null;
  if (gitStatus === null && !gitError) {
    // 首次加载中 → 不渲染 (避免空骨架闪烁)
  } else if (gitError) {
    // 未装 git 等 → 整个药丸隐藏 (侧栏展开后侧栏内显示红字)
  } else if (gitStatus && !gitStatus.is_repo) {
    // 非 git 仓库 → 灰显, 仍可点击展开 (PRD: 安静降级不报错, 侧栏内有提示)
    gitPill = (
      <button
        onClick={() => toggleRightPanel("git")}
        className={`ct-pill ${rightPanel === "git" ? pillOn : pillOff}`}
        title="非 Git 仓库"
      >
        非 Git 仓库
      </button>
    );
  } else {
    const changeCount = gitStatus?.files.length ?? 0;
    gitPill = (
      <button
        onClick={() => toggleRightPanel("git")}
        className={`ct-pill flex items-center gap-2 tabular-nums ${rightPanel === "git" ? pillOn : pillOff}`}
        title={`分支 ${gitStatus?.branch ?? "—"} · ${changeCount} 个变更`}
      >
        <GitBranch className="h-[15px] w-[15px]" />
        <span className="max-w-[120px] truncate">{gitStatus?.branch ?? "—"}</span>
        <span className="text-[var(--faint)]">·</span>
        <span>{changeCount}</span>
      </button>
    );
  }

  // 任务药丸入口: 项目装了 Trellis (tasks 目录存在) 才显示 (R3: 没装直接不显示)。纯图标钮。
  let trellisPill: ReactNode = null;
  if (trellisExists) {
    trellisPill = (
      <button
        onClick={() => toggleRightPanel("trellis")}
        className={`ct-pill !p-1 ${rightPanel === "trellis" ? pillOn : pillOff}`}
        title="Trellis 任务"
        aria-label="Trellis 任务"
      >
        <ListTree className="h-[15px] w-[15px]" />
      </button>
    );
  }

  // 舰队药丸入口: 有 artifact run 或本会话有 stream 条目就显示。纯图标钮,
  // 活动数用右上角 accent 圆点徽标 (替代原文字里的数字)
  let fleetPill: ReactNode = null;
  if (fleetRunCount > 0 || streamEntries.length > 0) {
    fleetPill = (
      <button
        onClick={() => toggleRightPanel("fleet")}
        className={`ct-pill relative !p-1 ${rightPanel === "fleet" ? pillOn : pillOff}`}
        title={fleetActiveCount > 0 ? `${fleetActiveCount} 个 subagent 活动中` : "查看 subagent 运行产物"}
        aria-label={fleetActiveCount > 0 ? `舰队 · ${fleetActiveCount} 活动中` : "舰队"}
      >
        <Radar className="h-[15px] w-[15px]" />
        {fleetActiveCount > 0 && (
          <span className="absolute right-0 top-0 flex h-[7px] w-[7px] translate-x-[2px] -translate-y-[2px] rounded-full bg-[var(--accent)] shadow-[0_0_4px_color-mix(in_oklch,var(--accent)_60%,transparent)]" />
        )}
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
        className="fixed inset-0 flex flex-col overflow-hidden bg-gradient-to-b from-white to-primary-100 text-neutral-900"
      >
      {/* 自绘标题栏 (无边框窗口顶部): 拖拽区 + 品牌 + 窗口控制; 之后内容行 (侧栏/主区/右面板) 纵向下移 */}
      <TitleBar />
      {/* 内容行: 侧栏 + 主区 + (子任务 4 的右侧面板 flex 兄弟位)。
          min-h-0 防止子项把内容行撑破 app-root 纵向空间 */}
      <div className="flex min-h-0 flex-1">
      <Sidebar onOpenPanel={setPanel} collapsed={sidebarCollapsed} onToggleCollapsed={toggleSidebar} />
      {/* relative: 供底部悬浮输入框 absolute 定位
          不压缩滚动区: 消息可滑到输入卡后方 (半透明可见), 底部留白由 MessageList 内部 padding 承担 */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-[color-mix(in_oklch,var(--chat-bg)_calc(var(--chat-alpha)_*_100%),transparent)] shadow-[-10px_0_24px_-12px_rgba(0,0,0,0.08)]">
        {isSwitching ? (
          <div className="flex flex-1 items-center justify-center">
            <ChaosLoader />
          </div>
        ) : active ? (
          <>
            <header className="flex items-center justify-between border-b border-[var(--border-soft)] px-6 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-title font-semibold text-[var(--fg)]">
                  {active.sessionName || active.cwd.split(/[\\/]/).filter(Boolean).pop()}
                </span>
                <span className="truncate text-mini text-[var(--faint)]" title={active.cwd}>
                  {active.cwd}
                </span>
                {active.isStreaming && (
                  <span className="flex shrink-0 items-center gap-1 text-mini text-[var(--muted)]">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    思考中
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {fleetPill}
                {gitPill}
                {trellisPill}
                <QueueIndicator steering={active.steeringQueue} followUp={active.followUpQueue} />
                <button
                  onClick={() => stopSession(activeSessionId!)}
                  className="rounded-md px-2 py-1 text-label text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--muted)]"
                >
                  关闭会话
                </button>
              </div>
            </header>
            {/* 错误提示放 header 下方: 悬浮输入框会盖住底部区域, 放底部看不见 */}
            {active?.error && (
              <div className="border-b border-[color-mix(in_oklch,var(--danger)_25%,transparent)] bg-[color-mix(in_oklch,var(--danger)_10%,transparent)] px-6 py-2 text-body text-[var(--danger)]">
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

      {/* 右侧面板: main 的 flex 兄弟 (改版稿 .side-panel, 展开时 main 让位, 收起恢复全宽,
          由 flex 自然完成)。单一 rightPanel state 保证同时只显一个。 */}
      {active && rightPanel && (
        <RightPanel>
          {rightPanel === "git" ? (
            <GitSidebarPanel cwd={active.cwd} onClose={() => setRightPanel(null)} />
          ) : rightPanel === "fleet" ? (
            <FleetSidebarPanel onClose={() => setRightPanel(null)} />
          ) : (
            <TrellisSidebarPanel cwd={active.cwd} onClose={() => setRightPanel(null)} />
          )}
        </RightPanel>
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
          <div className="flex h-full w-[380px] flex-col border-l border-neutral-200 bg-panel shadow-lg">
            <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
              <span className="font-medium">
                {panel === "skills" ? "Skill 管理" : "pi Package"}
              </span>
              <button
                onClick={() => setPanel(null)}
                className="rounded-md p-1 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-100 hover:text-neutral-700"
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
      {/* 内容行 div 闭合 */}
      </div>
    </>
  );
}
