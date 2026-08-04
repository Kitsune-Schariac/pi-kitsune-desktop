import { useEffect, useState } from "react";
import { useSessionStore } from "./store/session";
import { useProjectsStore } from "./store/projects";
import { MessageList } from "./components/MessageList";
import { InputBar } from "./components/InputBar";
import { Sidebar } from "./components/Sidebar";
import { EmptyState } from "./components/EmptyState";
import { ChaosLoader } from "./components/ChaosLoader";
import { SettingsWindow } from "./components/settings/SettingsWindow";
import { SkillsPanel } from "./components/panels/SkillsPanel";
import { PackagesPanel } from "./components/panels/PackagesPanel";
import { NotificationToasts, UiRequestModal } from "./components/UiRequestModal";
import { Loader2, X } from "lucide-react";

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
  const [panel, setPanel] = useState<PanelKind>(null);
  // 空状态: 项目选择器的选中值 (InputBar 发送时自动建会话用)
  const [emptyProject, setEmptyProject] = useState("");
  // 悬浮输入卡高度: 动态撑开消息区底部留白, 避免高输入框遮挡最后一条消息
  const [inputBarH, setInputBarH] = useState(0);
  // 启动即加载侧边栏数据 (无连接面板, 直接进主界面)
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white text-neutral-900">
      <Sidebar onOpenPanel={setPanel} />
      {/* relative: 供底部悬浮输入框 absolute 定位
          不压缩滚动区: 消息可滑到输入卡后方 (半透明可见), 底部留白由 MessageList 内部 padding 承担 */}
      <main className="relative flex min-w-0 flex-1 flex-col">
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
                <span className="truncate text-xs text-neutral-400" title={active.cwd}>
                  {active.cwd}
                </span>
                {active.isStreaming && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    思考中
                  </span>
                )}
              </div>
              <button
                onClick={() => stopSession(activeSessionId!)}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600"
              >
                关闭会话
              </button>
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
          <EmptyState project={emptyProject} onProjectChange={setEmptyProject} />
        )}
        <InputBar emptyProject={emptyProject} onHeightChange={setInputBarH} />
      </main>

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

      {/* 右侧面板抽屉 (Skill/package) */}
      {panel && (
        <div className="absolute inset-0 z-40 flex justify-end bg-neutral-900/10">
          <div className="flex h-full w-[380px] flex-col border-l border-neutral-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
              <span className="font-medium">
                {panel === "skills" ? "Skill 管理" : panel === "packages" ? "pi Package" : "设置"}
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
  );
}
