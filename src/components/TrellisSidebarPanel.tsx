// Trellis 任务侧栏面板: 会话区右侧内嵌面板, 两态视图机 list → detail。
// 交互骨架对齐 GitSidebarPanel (右侧内嵌圆角卡片、左缘拖拽调宽、Esc 层级)。
// 数据源: store/trellisTasks.ts 快照 (打开面板拉一次 + 手动刷新, 不轮询 —— 任务状态无
// 机器事件源且变化频率极低, design 关键决策), 与 pi 完全解耦、纯只读 (PRD R4)。
// list 态: 任务树嵌套渲染 (根 = 无 parent 或 parent 不在显示集内, 剪环防死循环) +
// 状态灯 + 徽章 + 当前活动任务高亮 + 「显示归档」切换; detail 态: 元信息 + 产物 tab,
// Markdown 复用 components/Markdown.tsx (remark-gfm 任务列表原生渲染 - [x])。
// 视觉走皮肤 CSS token (surface/border/primary/neutral), 禁 backdrop-filter/emoji/硬编码色。
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ListTree, FileText, RefreshCw, Loader2, X, ChevronLeft, AlertCircle, Archive,
} from "lucide-react";
import {
  useTrellisTasksStore, isCurrentTask, resolveParentRef,
  type TrellisTaskSummary,
} from "../store/trellisTasks";
import { Markdown } from "./Markdown";

// 两态视图: list 为顶层, detail 从 list 进入; detail→list 是 Esc 与 ‹返回的回退路径,
// list 不响应 Esc (常驻面板)。
type View = { kind: "list" } | { kind: "detail"; dir: string };

// 规划产物 tab (Rust 侧白名单三选一)
type DocKind = "prd" | "design" | "implement";
const DOC_META: Record<DocKind, { label: string; file: string }> = {
  prd: { label: "PRD", file: "prd.md" },
  design: { label: "设计", file: "design.md" },
  implement: { label: "实施", file: "implement.md" },
};
const DOC_ORDER: DocKind[] = ["prd", "design", "implement"];


// 任务树节点 (build 剪环后的干净结构, 渲染期纯递归无环风险)
interface TaskTreeNode {
  task: TrellisTaskSummary;
  children: TaskTreeNode[];
}

/**
 * 构建任务树: parent 宽容解析 (短名/路径兼容), 根 = 无 parent 或 parent 不在显示集内;
 * visited 剪环 —— task.json 数据出现 A→B→A 引用环时不死循环, 环中任务兜底输出为根。
 * tasks 已由 Rust 排序 (目录名倒序 = 新任务在前), children 继承该顺序。
 */
function buildTaskTree(tasks: TrellisTaskSummary[]): TaskTreeNode[] {
  const byDir = new Map(tasks.map((t) => [t.dir, t]));
  const childrenOf = new Map<string, TrellisTaskSummary[]>();
  const roots: TrellisTaskSummary[] = [];
  for (const t of tasks) {
    const p = t.parent ? resolveParentRef(t.parent, t.dir, byDir, tasks) : null;
    if (p) {
      if (!childrenOf.has(p.dir)) childrenOf.set(p.dir, []);
      childrenOf.get(p.dir)!.push(t);
    } else {
      roots.push(t);
    }
  }
  const visited = new Set<string>();
  const walk = (t: TrellisTaskSummary): TaskTreeNode => {
    visited.add(t.dir);
    return {
      task: t,
      children: (childrenOf.get(t.dir) ?? [])
        .filter((c) => !visited.has(c.dir))
        .map(walk),
    };
  };
  const rootNodes = roots.map(walk);
  // 环中未访问的任务兜底为根 (数据异常也不丢任务)
  for (const t of tasks) {
    if (!visited.has(t.dir)) rootNodes.push(walk(t));
  }
  return rootNodes;
}

// 任务状态灯: in_progress = primary 呼吸 (animate-pulse); planning = 中性蓝灰;
// completed = 中性灰; 未知/空 = 更浅灰。全部随主题翻转, 无固定深浅语义。
function TaskStatusDot({ status }: { status: string }) {
  const t = (status || "").toLowerCase();
  if (t === "in_progress" || t === "in-progress") {
    return (
      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--accent)] animate-pulse" />
    );
  }
  if (t === "planning") {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-neutral-400" />;
  }
  if (t === "completed" || t === "done") {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-neutral-500" />;
  }
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-neutral-300" />;
}

interface Props {
  cwd: string;
  onClose: () => void;
}

export function TrellisSidebarPanel({ cwd, onClose }: Props) {
  const tasks = useTrellisTasksStore((s) => s.tasks);
  const exists = useTrellisTasksStore((s) => s.exists);
  const loading = useTrellisTasksStore((s) => s.loading);
  const lastError = useTrellisTasksStore((s) => s.lastError);
  const currentTaskRef = useTrellisTasksStore((s) => s.currentTaskRef);
  const load = useTrellisTasksStore((s) => s.load);

  const [view, setView] = useState<View>({ kind: "list" });
  const [showArchived, setShowArchived] = useState(false);

  // 挂载/切项目重拉快照 + 回 list (避免残留旧项目的 detail 视图)
  useEffect(() => {
    load(cwd);
    setView({ kind: "list" });
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc 层级: detail → list; list 不响应 (常驻面板)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (view.kind === "detail") setView({ kind: "list" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  // 显示集: 归档默认不显示 (PRD R1), 切换后才并入; 树随过滤结果重建
  const visibleTasks = useMemo(
    () => (showArchived ? tasks : tasks.filter((t) => !t.is_archived)),
    [tasks, showArchived],
  );
  const tree = useMemo(() => buildTaskTree(visibleTasks), [visibleTasks]);
  const archiveCount = useMemo(() => tasks.filter((t) => t.is_archived).length, [tasks]);
  // detail 态任务对象: 从最新 tasks 按 dir 找 (快照刷新后引用更新), 消失 (归档且未显) → 回 list
  const detailTask = useMemo(
    () => (view.kind === "detail" ? tasks.find((t) => t.dir === view.dir) ?? null : null),
    [tasks, view],
  );

  return (
    <>
        {view.kind === "list" ? (
          // list header: 标题 + 计数 + 归档切换 + 刷新 + 收起
          <div className="flex items-center justify-between border-b border-[var(--border-soft)] px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <ListTree className="h-4 w-4 shrink-0 text-[var(--muted)]" />
              <span className="text-title font-medium">任务</span>
              {visibleTasks.length > 0 && (
                <span className="text-mini text-[var(--faint)]">· {visibleTasks.length}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {archiveCount > 0 && (
                <button
                  onClick={() => setShowArchived(!showArchived)}
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-mini transition duration-fast ease-out ${
                    showArchived
                      ? "bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] text-[var(--muted)]"
                      : "text-[var(--faint)] hover:bg-[var(--surface-2)] hover:text-[var(--muted)]"
                  }`}
                  title={showArchived ? "隐藏归档任务" : `显示归档任务 (${archiveCount})`}
                >
                  <Archive className="h-4 w-4" />
                  归档
                </button>
              )}
              <button
                onClick={() => load(cwd)}
                disabled={loading}
                className="rounded-md p-1 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--muted)] disabled:opacity-40"
                title="刷新"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={onClose}
                className="rounded-md p-1 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--muted)]"
                title="收起"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          // detail header: ‹ 返回 + 状态灯 + 标题 (+ 归档标记)
          <div className="flex items-center gap-2 border-b border-[var(--border-soft)] px-3 py-2">
            <button
              onClick={() => setView({ kind: "list" })}
              className="flex items-center rounded-md p-1 text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
              title="返回 (Esc)"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {detailTask && (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <TaskStatusDot status={detailTask.status} />
                <span className="truncate text-title font-medium" title={detailTask.title}>
                  {detailTask.title}
                </span>
                {detailTask.is_archived && (
                  <span className="flex shrink-0 items-center gap-1 text-mini text-[var(--faint)]">
                    <Archive className="h-3 w-3" />
                    归档
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto">
          {view.kind === "list" ? (
            lastError ? (
              // 快照读取失败: 降级红条 + 空态文案 (R3: 不把失败渲染成崩溃)
              <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
                <AlertCircle className="h-8 w-8 text-[var(--danger)]" />
                <p className="text-body text-[var(--danger)]">{lastError}</p>
                <p className="text-mini text-[var(--faint)]">读取 Trellis 任务失败</p>
              </div>
            ) : !exists ? (
              // 无 Trellis 项目 (R3): 安静空态, 不报错。药丸本就不显示, 此处是直接开面板的兜底
              <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
                <ListTree className="h-8 w-8 text-[var(--faint)]" />
                <p className="text-body text-[var(--faint)]">此项目未使用 Trellis</p>
                <p className="text-mini text-[var(--faint)]">项目 .trellis/ 目录不存在</p>
              </div>
            ) : loading && tasks.length === 0 ? (
              <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="加载中…" />
            ) : visibleTasks.length === 0 ? (
              // 装了 Trellis 但无任务 (或归档隐藏后为空): 与「未使用」区分文案
              <Hint text={showArchived ? "无任务" : "暂无活动任务"} />
            ) : (
              <div className="py-1">
                {tree.map((node) => (
                  <TaskNode
                    key={node.task.dir}
                    node={node}
                    depth={0}
                    currentTaskRef={currentTaskRef}
                    onOpen={(dir) => setView({ kind: "detail", dir })}
                  />
                ))}
              </div>
            )
          ) : detailTask ? (
            <TaskDetail cwd={cwd} task={detailTask} />
          ) : (
            // 选中任务已不在快照 (被归档/删除且过滤) → 提示后由用户返回
            <Hint text="任务不在当前列表中" />
          )}
        </div>
    </>
  );
}

// 树节点递归渲染: 任务行 + 子任务嵌套 (左缘竖线 + 缩进, 复用舰队 StepCard 嵌套视觉)
function TaskNode({
  node, depth, currentTaskRef, onOpen,
}: {
  node: TaskTreeNode;
  depth: number;
  currentTaskRef: string | null;
  onOpen: (dir: string) => void;
}) {
  return (
    <div>
      <TaskRow
        task={node.task}
        depth={depth}
        isCurrent={isCurrentTask(node.task.dir, currentTaskRef)}
        onOpen={onOpen}
      />
      {node.children.length > 0 && (
        <div className="ml-3 border-l-2 border-[var(--border-subtle)] pl-1">
          {node.children.map((c) => (
            <TaskNode
              key={c.task.dir}
              node={c}
              depth={depth + 1}
              currentTaskRef={currentTaskRef}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 任务行: 状态灯 + title + 徽章 (priority / assignee 首字 / 产物数) + 当前任务高亮。
// 当前活动任务高亮描边 + 「活动」徽章 (仅单会话指针时信息可用, 多窗口不猜不标)。
function TaskRow({
  task, depth, isCurrent, onOpen,
}: {
  task: TrellisTaskSummary;
  depth: number;
  isCurrent: boolean;
  onOpen: (dir: string) => void;
}) {
  const docCount = (task.has_prd ? 1 : 0) + (task.has_design ? 1 : 0) + (task.has_implement ? 1 : 0);
  const assigneeInitial = task.assignee ? [...task.assignee.trim()][0] : null;
  return (
    <button
      onClick={() => onOpen(task.dir)}
      style={{ paddingLeft: `${depth * 4}px` }}
      className={`flex w-full items-center gap-2 py-2 pr-3 text-left transition duration-fast ease-out hover:bg-[var(--surface-2)] ${
        isCurrent
          ? "border-l-2 border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)]"
          : "border-l-2 border-transparent"
      } ${task.is_archived ? "opacity-60" : ""}`}
      title={`${task.title}${task.description ? `\n${task.description}` : ""}`}
    >
      <TaskStatusDot status={task.status} />
      <span
        className={`min-w-0 flex-1 truncate text-mini ${
          isCurrent ? "font-medium text-[var(--fg)]" : "text-[var(--muted)]"
        }`}
      >
        {task.title}
      </span>
      {isCurrent && (
        <span className="shrink-0 rounded-full border border-[color-mix(in_oklch,var(--accent)_45%,transparent)] px-2 py-px text-mini font-medium text-[var(--accent-strong)]">
          活动
        </span>
      )}
      {task.priority && (
        <span
          className={`shrink-0 text-mini tabular-nums ${
            task.priority === "P1" ? "font-medium text-[var(--accent-strong)]" : "text-[var(--faint)]"
          }`}
        >
          {task.priority}
        </span>
      )}
      {assigneeInitial && (
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-mini text-[var(--muted)]"
          title={task.assignee}
        >
          {assigneeInitial}
        </span>
      )}
      {docCount > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-[var(--faint)]" title={`${docCount} 个规划产物`}>
          <FileText className="h-3 w-3" />
          <span className="text-mini tabular-nums">{docCount}</span>
        </span>
      )}
    </button>
  );
}

// --- detail 态: 元信息 + 产物 tab + Markdown 渲染 ---

function TaskDetail({ cwd, task }: { cwd: string; task: TrellisTaskSummary }) {
  // 默认 tab = 第一个存在的产物 (轻量任务全缺时为 null, 显示占位)
  const firstDoc = task.has_prd ? "prd" : task.has_design ? "design" : task.has_implement ? "implement" : null;
  const [tab, setTab] = useState<DocKind | null>(firstDoc);
  const [content, setContent] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  // epoch 守卫 (spec 统一模式): 快速切任务/切 tab 时, 旧请求迟到的结果不得污染新视图
  const epochRef = useRef(0);

  useEffect(() => {
    if (!tab) return;
    const epoch = ++epochRef.current;
    setDocLoading(true);
    setDocError(null);
    setContent(null);
    invoke<string>("read_trellis_task_doc", { cwd, taskDir: task.dir, doc: tab })
      .then((c) => {
        if (epoch !== epochRef.current) return;
        setContent(c);
        setDocLoading(false);
      })
      .catch((e) => {
        if (epoch !== epochRef.current) return;
        setDocError(String(e));
        setDocLoading(false);
      });
  }, [cwd, task.dir, tab]);

  // 头部元信息: priority / assignee / createdAt / completedAt / 目录名
  const meta: string[] = [];
  if (task.priority) meta.push(task.priority);
  if (task.assignee) meta.push(task.assignee);
  if (task.created_at) meta.push(task.created_at);
  if (task.completed_at) meta.push(`完成于 ${task.completed_at}`);

  return (
    <div className="flex flex-col">
      {/* 元信息条 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-soft)] px-4 py-2 text-mini text-[var(--muted)]">
        {task.status && <span>{statusLabel(task.status)}</span>}
        {meta.map((m) => (
          <span key={m} className="flex items-center gap-2">
            <span className="text-[var(--faint)]">·</span>
            <span className="truncate tabular-nums" title={m}>{m}</span>
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1 truncate font-mono text-[var(--faint)]" title={task.dir}>
          <Archive className="h-3 w-3 shrink-0" />
          {task.dir}
        </span>
      </div>
      {/* 产物 tab: 有则亮, 无则置灰标「未创建」 (轻量任务合法状态, 非错误) */}
      <div className="flex items-center gap-1 border-b border-[var(--border-soft)] px-3 py-2">
        {DOC_ORDER.map((d) => {
          const available = docAvailable(task, d);
          const active = tab === d;
          return (
            <button
              key={d}
              onClick={() => available && setTab(d)}
              disabled={!available}
              className={`rounded-md px-2 py-1 text-mini transition duration-fast ease-out ${
                active
                  ? "bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] font-medium text-[var(--fg)]"
                  : available
                    ? "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--muted)]"
                    : "cursor-not-allowed text-[var(--faint)]"
              }`}
              title={available ? `查看 ${DOC_META[d].file}` : `${DOC_META[d].file} 未创建`}
            >
              {DOC_META[d].label}
              {!available && <span className="ml-1 text-mini">未创建</span>}
            </button>
          );
        })}
      </div>
      {/* 文档内容: 加载 / 错误 / 未创建 / Markdown 四态 */}
      <div className="flex-1">
        {docError ? (
          <p className="px-4 py-6 text-body text-[var(--danger)]">{docError}</p>
        ) : docLoading ? (
          <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="加载中…" />
        ) : !tab ? (
          <Hint icon={<FileText className="h-4 w-4" />} text="该任务没有任何规划产物" />
        ) : content === "" ? (
          <Hint icon={<FileText className="h-4 w-4" />} text={`${DOC_META[tab].file} 未创建`} />
        ) : content !== null ? (
          <div className="p-4">
            <Markdown text={content} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 产物可用性查询 (tab 显隐与默认选中共用同一判据)
function docAvailable(task: TrellisTaskSummary, doc: DocKind): boolean {
  if (doc === "prd") return task.has_prd;
  if (doc === "design") return task.has_design;
  return task.has_implement;
}

// status 原始值 → 中文展示 (未知值透传原文, 上游新增状态时不至于空白)
function statusLabel(status: string): string {
  const map: Record<string, string> = {
    planning: "规划中",
    in_progress: "进行中",
    completed: "已完成",
  };
  return map[status] ?? status;
}

// 列表空态与加载提示, 复用于多分支降级路径
function Hint({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-body text-[var(--faint)]">
      {icon}
      {text}
    </div>
  );
}