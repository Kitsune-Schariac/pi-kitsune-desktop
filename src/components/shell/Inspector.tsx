import { useMemo, type ReactNode } from "react";
import { Activity, Bot, FolderTree, GitBranch, X } from "lucide-react";
import { useSessionStore } from "../../store/session";
import { useGitStore } from "../../store/git";
import { useFleetStore, parseSessionUuid } from "../../store/fleet";
import { useFleetStreamEntries } from "../../hooks/useFleetStreamEntries";
import { useUiStore, type InspectorTab } from "../../store/ui";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { GitSidebarPanel } from "../GitSidebarPanel";
import { FleetSidebarPanel } from "../FleetSidebarPanel";
import { StepDetail } from "../inspector/StepDetail";
import { SessionOverview } from "../inspector/SessionOverview";
import { FilesSidebarPanel } from "../inspector/FilesSidebarPanel";
import { Segmented } from "../ui";

/**
 * 检查器 (框架 C 第四列): 概览 / 文件 / Git / 代理四个正交页签。
 * 常驻 flex 列 (左缘拖拽调宽), 收起即卸载让位。
 * 内嵌面板均由顶部页签承载收起职责 (onClose 传空)。
 */
export function Inspector() {
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorTab = useUiStore((s) => s.inspectorTab);
  const setInspectorTab = useUiStore((s) => s.setInspectorTab);
  const setInspectorOpen = useUiStore((s) => s.setInspectorOpen);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.cwd : undefined;
  });
  const fleetEnabled = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? (s.sessions[id]?.capabilities.fleetView ?? true) : true;
  });

  // 概览页签的选中步骤: 选中 id 在当前会话 entries 里找不到 (切会话 / 历史刷新丢条目) 时回落概览遥测
  const selectedStepId = useUiStore((s) => s.selectedStepId);
  const entries = useSessionStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId]?.entries : undefined,
  );
  const selectedEntry = useMemo(
    () =>
      selectedStepId && entries
        ? entries.find((e) => e.id === selectedStepId && e.kind === "tool") ?? null
        : null,
    [selectedStepId, entries],
  );
  const gitStatus = useGitStore((s) => (cwd ? s.statusByCwd[cwd] ?? null : null));
  const gitReady = gitStatus !== null;
  const gitIsRepo = gitStatus?.is_repo ?? false;
  const gitChangeCount = gitStatus?.files.length ?? 0;

  // 代理活动数: stream running + 本会话 artifact running (无活动会话时计全局 artifact)
  const runs = useFleetStore((s) => s.runs);
  const sessionPath = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.sessionPath : null;
  });
  const currentUuid = useMemo(() => parseSessionUuid(sessionPath), [sessionPath]);
  const streamEntries = useFleetStreamEntries();
  const agentActiveCount = useMemo(() => {
    const streamRunning = streamEntries.filter((e) => e.state === "running").length;
    if (!activeSessionId) {
      return runs.filter((r) => r.active).length;
    }
    if (currentUuid === "") {
      return streamRunning;
    }
    const localArtifactActive = runs.filter(
      (r) => r.active && r.session_id === currentUuid,
    ).length;
    return streamRunning + localArtifactActive;
  }, [activeSessionId, currentUuid, streamEntries, runs]);

  const { width, dragging, onDragStart } = useResizableWidth({
    storageKey: "kitsune.rightPanelWidth",
    defaultValue: 380,
    min: 300,
    max: 760,
    direction: -1,
  });

  if (!inspectorOpen) return null;

  const tabs: { key: InspectorTab; label: string; icon: ReactNode; disabled?: boolean; badge?: ReactNode }[] = [
    { key: "overview", label: "概览", icon: <Activity className="h-[13px] w-[13px]" /> },
    { key: "files", label: "文件", icon: <FolderTree className="h-[13px] w-[13px]" /> },
    {
      key: "git",
      label: "Git",
      icon: <GitBranch className="h-[13px] w-[13px]" />,
      disabled: gitReady && !gitIsRepo,
      badge:
        gitReady && gitIsRepo && gitChangeCount > 0 ? (
          <span className="font-mono text-meta tabular-nums text-fg-4">
            {gitChangeCount}
          </span>
        ) : null,
    },
    ...(fleetEnabled
      ? [{
          key: "agents" as const,
          label: "代理",
          icon: <Bot className="h-[13px] w-[13px]" />,
          badge: agentActiveCount > 0 ? <span className="live-dot" /> : null,
        }]
      : []),
  ];
  const effectiveTab: InspectorTab =
    inspectorTab === "agents" && !fleetEnabled ? "overview" : inspectorTab;

  return (
    <aside style={{ width }} className="inspector inspector-col">
      {/* 列头 (--bar-h): 四页签分段控件 + 收起按钮 */}
      <div className="bar gap-2 pl-3 pr-2">
        <Segmented
          size="sm"
          value={effectiveTab}
          onChange={setInspectorTab}
          ariaLabel="检查器页签"
          options={tabs.map(({ key, label, icon, disabled, badge }) => ({
            value: key,
            disabled,
            title: disabled ? "非 Git 仓库" : label,
            label: (
              <>
                {icon}
                <span>{label}</span>
                {badge}
              </>
            ),
          }))}
        />
        <button
          onClick={() => setInspectorOpen(false)}
          className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-md text-fg-4 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
          title="收起检查器"
          aria-label="收起检查器"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {effectiveTab === "overview" ? (
          selectedEntry ? (
            <StepDetail key={selectedEntry.id} entry={selectedEntry} cwd={cwd} />
          ) : (
            <SessionOverview />
          )
        ) : effectiveTab === "files" ? (
          <FilesSidebarPanel cwd={cwd} />
        ) : effectiveTab === "git" ? (
          <GitSidebarPanel cwd={cwd} />
        ) : (
          <FleetSidebarPanel />
        )}
      </div>

      {/* 左缘宽度拖拽手柄 */}
      <div
        onMouseDown={onDragStart}
        className="group absolute inset-y-0 left-0 z-10 w-[7px] cursor-col-resize"
        title="拖动调整宽度"
      >
        <div
          className={`absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-colors duration-fast ${
            dragging ? "bg-fg-3" : "bg-transparent group-hover:bg-line-2"
          }`}
        />
      </div>
    </aside>
  );
}
