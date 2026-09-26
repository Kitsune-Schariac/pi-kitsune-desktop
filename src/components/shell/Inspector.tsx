import { useEffect, useMemo, type ReactNode } from "react";
import { GitBranch, ListTree, Radar, ScanSearch, X } from "lucide-react";
import { useSessionStore } from "../../store/session";
import { useGitStore } from "../../store/git";
import { useFleetStore, parseSessionUuid } from "../../store/fleet";
import { useFleetStreamEntries } from "../../hooks/useFleetStreamEntries";
import { useTrellisTasksStore } from "../../store/trellisTasks";
import { useThemeStore } from "../../store/theme";
import { useUiStore, type InspectorTab } from "../../store/ui";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { GitSidebarPanel } from "../GitSidebarPanel";
import { FleetSidebarPanel } from "../FleetSidebarPanel";
import { TrellisSidebarPanel } from "../TrellisSidebarPanel";
import { StepDetail } from "../inspector/StepDetail";

/**
 * 检查器 (框架 C 第四列): 详情 / Git / 舰队 / 任务四个页签。
 * 工坊 = 常驻 flex 列 (左缘拖拽调宽), 舞台 = 从右滑出的浮卡 (index.css 按 data-style 分支)。
 * 三个内嵌面板沿用现有实现, 只去掉各自的关闭按钮 (onClose 传空)。
 */
export function Inspector() {
  const activeHasBg = useThemeStore((s) => s.activeHasBg);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorTab = useUiStore((s) => s.inspectorTab);
  const setInspectorTab = useUiStore((s) => s.setInspectorTab);
  const setInspectorOpen = useUiStore((s) => s.setInspectorOpen);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const cwd = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.cwd : undefined;
  });

  // 详情页签的选中步骤: 选中 id 在当前会话 entries 里找不到 (切会话 / 历史刷新丢条目) 时回落概览占位
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

  // 舰队活动数: 算法自 App.tsx 原样搬入, 口径不变 (stream running + 本会话 artifact running)
  const runs = useFleetStore((s) => s.runs);
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
      return streamRunning;
    }
    const localArtifactActive = runs.filter(
      (r) => r.active && r.session_id === currentUuid,
    ).length;
    return streamRunning + localArtifactActive;
  }, [activeSessionId, currentUuid, streamEntries, runs]);

  const trellisExists = useTrellisTasksStore((s) => s.exists);

  const { width, dragging, onDragStart } = useResizableWidth({
    storageKey: "kitsune.rightPanelWidth",
    defaultValue: 360,
    min: 280,
    max: 720,
    direction: -1,
  });

  // 舞台下文字列让位宽度 (阶段 3 的 Timeline 消费); 工坊由 flex 列天然占位, 不需要让位
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--insp-w",
      activeHasBg && inspectorOpen ? `${width}px` : "0px",
    );
  }, [activeHasBg, inspectorOpen, width]);

  if (!inspectorOpen && !activeHasBg) return null;
  // 舞台下常驻挂载: 浮卡用 class 切滑出/滑入 (卸载重挂只能播一次性入场动画, 表达不了"滑出");
  // 工坊是 grid 常驻列, 收起即卸载让位

  const tabs: { key: InspectorTab; label: string; icon: ReactNode; disabled?: boolean; badge?: ReactNode }[] = [
    { key: "detail", label: "详情", icon: <ScanSearch className="h-[14px] w-[14px]" /> },
    {
      key: "git",
      label: "Git",
      icon: <GitBranch className="h-[14px] w-[14px]" />,
      // 非仓库或状态未就绪 → 灰显; 状态就绪的仓库显示变更数徽标
      disabled: gitReady && !gitIsRepo,
      badge:
        gitReady && gitIsRepo && gitChangeCount > 0 ? (
          <span className="font-mono text-micro tabular-nums text-[var(--fg-4)]">
            {gitChangeCount}
          </span>
        ) : null,
    },
    {
      key: "fleet",
      label: "舰队",
      icon: <Radar className="h-[14px] w-[14px]" />,
      badge:
        fleetActiveCount > 0 ? (
          <span className="h-[6px] w-[6px] rounded-full bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]" />
        ) : null,
    },
    ...(trellisExists
      ? [{ key: "trellis" as const, label: "任务", icon: <ListTree className="h-[14px] w-[14px]" /> }]
      : []),
  ];

  return (
    <aside style={{ width }} className={`inspector inspector-col ${inspectorOpen ? "" : "insp-closed"}`}>
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--line)] px-4">
        {tabs.map(({ key, label, icon, disabled, badge }) => (
          <button
            key={key}
            className={`insp-tab ${inspectorTab === key ? "on" : ""}`}
            disabled={disabled}
            onClick={() => setInspectorTab(key)}
            title={disabled ? "非 Git 仓库" : label}
          >
            {icon}
            <span>{label}</span>
            {badge}
          </button>
        ))}
        <button
          onClick={() => setInspectorOpen(false)}
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-[var(--fg-4)] transition-colors duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          title="收起检查器"
          aria-label="收起检查器"
        >
          <X className="h-[14px] w-[14px]" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {inspectorTab === "detail" ? (
          selectedEntry ? (
            <StepDetail key={selectedEntry.id} entry={selectedEntry} cwd={cwd} />
          ) : (
            // 概览是阶段 4 的实现范围; 未选中步骤时占位
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <h2 className="text-title font-medium text-[var(--fg)]">会话概览</h2>
              <p className="mt-2 text-label text-[var(--fg-4)]">阶段 4 实现</p>
            </div>
          )
        ) : inspectorTab === "git" ? (
          <GitSidebarPanel cwd={cwd} />
        ) : inspectorTab === "fleet" ? (
          <FleetSidebarPanel />
        ) : (
          <TrellisSidebarPanel cwd={cwd ?? ""} />
        )}
      </div>

      {/* 左缘宽度拖拽手柄: 舞台浮卡与工坊列共用 */}
      <div
        onMouseDown={onDragStart}
        className="group absolute inset-y-0 left-0 z-10 w-[7px] cursor-col-resize"
        title="拖动调整宽度"
      >
        <div
          className={`absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-colors duration-fast ${
            dragging ? "bg-[var(--accent)]" : "bg-transparent group-hover:bg-[var(--line-2)]"
          }`}
        />
      </div>
    </aside>
  );
}
