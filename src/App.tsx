import { useEffect, useState } from "react";
import { useSessionStore } from "./store/session";
import { useProjectsStore } from "./store/projects";
import { Timeline } from "./components/timeline/Timeline";
import { InputBar } from "./components/InputBar";
import { EmptyState } from "./components/EmptyState";
import { ChaosLoader } from "./components/ChaosLoader";
import { TitleBar } from "./components/TitleBar";
import { Rail } from "./components/shell/Rail";
import { SessionPane } from "./components/shell/SessionPane";
import { StageHead } from "./components/shell/StageHead";
import { Inspector } from "./components/shell/Inspector";
import { StageBackdrop } from "./components/shell/StageBackdrop";
import { SettingsWindow, type SettingsSection } from "./components/settings/SettingsWindow";
import { SkillsPanel } from "./components/panels/SkillsPanel";
import { PackagesPanel } from "./components/panels/PackagesPanel";
import { NotificationToasts, UiRequestModal } from "./components/UiRequestModal";
import { useThemeStore } from "./store/theme";
import { usePetStore } from "./store/pet";
import { useGitStore } from "./store/git";
import { useFleetStore } from "./store/fleet";
import { useTrellisTasksStore } from "./store/trellisTasks";
import { useUiStore } from "./store/ui";
import { X } from "lucide-react";

export type PanelKind = "skills" | "packages" | "settings" | null;

export default function App() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const active = activeSessionId ? sessions[activeSessionId] : null;
  const isSwitching = useSessionStore((s) => s.isSwitching);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const resolveUiRequest = useSessionStore((s) => s.resolveUiRequest);
  const notifications = useSessionStore((s) => s.notifications);
  const dismissNotification = useSessionStore((s) => s.dismissNotification);
  const clearStep = useUiStore((s) => s.clearStep);
  const setInspectorTab = useUiStore((s) => s.setInspectorTab);
  const setInspectorOpen = useUiStore((s) => s.setInspectorOpen);

  // cwd 用单 selector 取字符串: sessions map 随消息流频繁变, cwd 不变则不重渲染
  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.cwd : undefined;
  });
  const loadGitStatus = useGitStore((s) => s.loadStatus);
  const loadTrellisTasks = useTrellisTasksStore((s) => s.load);
  // 风格 (壁纸皮肤 = 舞台) 是检查器初值的依据; 主题未就绪前不动 (避免启动时闪一下再收起)
  const activeHasBg = useThemeStore((s) => s.activeHasBg);
  const themeReady = useThemeStore((s) => s.skins.length > 0);

  // 浮层路由: 抽屉 (Skill/Package) 与设置窗共用单一 state; 设置窗记目标分区 (Rail 快捷入口)
  const [panel, setPanel] = useState<PanelKind>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("theme");
  // 空状态: 项目选择器的选中值 (InputBar 发送时自动建会话用)
  const [emptyProject, setEmptyProject] = useState("");
  // 悬浮输入卡高度: 动态撑开消息区底部留白, 避免高输入框遮挡最后一条消息
  const [inputBarH, setInputBarH] = useState(0);

  // 启动即加载侧边栏数据 (无连接面板, 直接进主界面)
  useEffect(() => {
    loadProjects();
    // 主题皮肤系统: 拉皮肤列表 + 恢复持久化 + 应用当前主题 (模块级防重入)
    useThemeStore.getState().init();
    // 桌宠: 订阅会话状态做聚合 + 挂桌宠窗口事件桥 + 上次开着就自动开回来 (模块级防重入)
    usePetStore.getState().init();
  }, [loadProjects]);

  // 舰队初始快照: App 挂载拉一次 runs (后台 run 在 GUI 重启后仍可被发现, 检查器页签徽标用)
  useEffect(() => {
    void useFleetStore.getState().refresh();
  }, []);

  // 检查器开合随风格初始化 (不持久化): 工坊展开常驻一列, 舞台收起把右侧让给角色
  useEffect(() => {
    if (themeReady) setInspectorOpen(!activeHasBg);
  }, [themeReady, activeHasBg, setInspectorOpen]);

  // 切会话清空检查器选中步 (选中 id 是 ChatEntry.id, 跨会话无意义)
  useEffect(() => {
    clearStep();
  }, [activeSessionId, clearStep]);

  // ToolCallCard 联动按钮 → fleet store panelRequest 递增 → 打开检查器舰队页签 (原右侧面板入口)
  const fleetPanelRequest = useFleetStore((s) => s.panelRequest);
  useEffect(() => {
    if (fleetPanelRequest > 0) {
      setInspectorTab("fleet");
      setInspectorOpen(true);
    }
  }, [fleetPanelRequest, setInspectorTab, setInspectorOpen]);

  // Git 状态拉取: cwd 变化拉一次 (检查器 Git 页签徽标常驻显示需要 status)。
  // diff 视图归面板内部管理, cwd 变化面板自行重置回 list, App 不再持有 diffTarget
  useEffect(() => {
    if (cwd) loadGitStatus(cwd);
  }, [cwd]);

  // Trellis 任务快照: cwd 变化拉一次, 服务检查器「任务」页签的显隐探测 (exists 判据)。
  // 无 .trellis 的项目 exists=false → 页签隐藏 (安静降级); 打开页签时面板内还会再拉刷新
  useEffect(() => {
    if (cwd) loadTrellisTasks(cwd);
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Rail 的统计/桌宠/设置入口: 打开设置窗并定位分区 */
  const openSettings = (section: SettingsSection) => {
    setSettingsSection(section);
    setPanel("settings");
  };

  return (
    <>
      {/* 舞台背景层: 仅壁纸皮肤渲染, fixed 铺满, 由 #app-root 的 z-10 压在上层之下 */}
      <StageBackdrop />
      <div id="app-root" className="fixed inset-0 z-10 flex flex-col overflow-hidden text-fg">
        {/* 自绘标题栏: 拖拽区 + 品牌 + 窗口控制 */}
        <TitleBar />
        {/* 内容行 (框架 C): 图标轨 | 会话列表 | 舞台 | 检查器。
            relative: 供舞台风格下检查器浮卡定位 */}
        <div className="relative flex min-h-0 flex-1">
          <Rail onOpenPanel={setPanel} onOpenSettings={openSettings} />
          <SessionPane />
          {/* 舞台: 主区底用 --bg (舞台下 transparent, 由背景层提供壁纸) */}
          <main className="relative flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
            {isSwitching ? (
              <div className="flex flex-1 items-center justify-center">
                <ChaosLoader />
              </div>
            ) : active ? (
              <>
                <StageHead />
                {/* 错误提示放头部下方: 悬浮输入框会盖住底部区域, 放底部看不见 */}
                {active.error && (
                  <div className="shrink-0 border-b border-[color-mix(in_oklch,var(--err)_25%,transparent)] bg-[color-mix(in_oklch,var(--err)_10%,transparent)] px-5 py-2 text-body text-[var(--err)]">
                    {active.error}
                  </div>
                )}
                <Timeline inputBarH={inputBarH} />
              </>
            ) : (
              <EmptyState />
            )}
            <InputBar
              emptyProject={emptyProject}
              onEmptyProjectChange={setEmptyProject}
              onHeightChange={setInputBarH}
              onOpenPanel={setPanel}
            />
            {/* 扩展 notify 通知条: 挂进主区 (StageHead 下方右上), 不遮输入卡 —
                详情与合并规则见 NotificationToasts */}
            {notifications.length > 0 && (
              <NotificationToasts notifications={notifications} onDismiss={dismissNotification} />
            )}
          </main>
          {/* 检查器: 有活动会话才渲染 (无会话时详情/面板都无主体可挂) */}
          {active && <Inspector />}
        </div>

        {/* 扩展 UI 请求弹窗: 只渲染活跃会话的队头请求 (FIFO, 关闭后自动弹下一个) */}
        {active && active.uiRequests.length > 0 && (
          <UiRequestModal
            request={active.uiRequests[0]}
            onResolve={(id, payload) => resolveUiRequest(activeSessionId!, id, payload)}
            onCancel={(id) => resolveUiRequest(activeSessionId!, id, { cancelled: true })}
          />
        )}

        {/* 设置: 独立模态窗口 (与抽屉并存, 不冲突); initialSection 供 Rail 快捷入口定位 */}
        {panel === "settings" && (
          <SettingsWindow onClose={() => setPanel(null)} initialSection={settingsSection} />
        )}

        {/* Skill / Package 抽屉: settings 走独立模态窗, 不进抽屉, 否则多出空白抽屉 */}
        {(panel === "skills" || panel === "packages") && (
          <div className="absolute inset-0 z-40 flex justify-end bg-black/10">
            <div className="flex h-full w-[380px] flex-col border-l border-[var(--line)] bg-popover shadow-[var(--shadow)]">
              <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
                <span className="font-medium text-fg">
                  {panel === "skills" ? "Skill 管理" : "pi Package"}
                </span>
                <button
                  onClick={() => setPanel(null)}
                  className="rounded-md p-1 text-fg-4 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
                  title="关闭"
                  aria-label="关闭"
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
