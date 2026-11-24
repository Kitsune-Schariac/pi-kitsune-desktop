import { memo, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  ListTodo,
  MinusCircle,
  X,
} from "lucide-react";
import type { PlanItem, PlanSnapshot } from "../../lib/agent";
import { Badge } from "../ui";

const PRIORITY_LABEL: Record<"high" | "medium" | "low", { text: string; tone: "warn" | "neutral" }> = {
  high: { text: "高", tone: "warn" },
  medium: { text: "中", tone: "neutral" },
  low: { text: "低", tone: "neutral" },
};

/**
 * 跨 Agent 统一任务清单悬浮卡 (挂在输入卡上方 `.composer-dock`):
 * - 默认折叠为单行紧凑进度条 (显示当前进行中项 + done/total + 细进度条), 不占对话空间
 * - 点击展开查看完整有序清单 (状态 / 优先级 / 备注 / 阻塞依赖)
 * - 当下方弹出引导提问卡 (`compactForce`) 时自动临时收起, 避免同时占满垂直视口
 */
export const TodoPlanCard = memo(function TodoPlanCard({
  plan,
  compactForce = false,
  onDismiss,
}: {
  plan: PlanSnapshot;
  compactForce?: boolean;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);

  // 引导回复卡出现时自动收起待办详情, 聚焦决策
  useEffect(() => {
    if (compactForce) setOpen(false);
  }, [compactForce]);

  const stats = useMemo(() => {
    let completed = 0;
    let inProgress: PlanItem | null = null;
    let firstPending: PlanItem | null = null;
    let activeTotal = 0;
    for (const item of plan.items) {
      if (item.status === "cancelled") continue;
      activeTotal += 1;
      if (item.status === "completed") completed += 1;
      else if (item.status === "in_progress" && !inProgress) inProgress = item;
      else if (item.status === "pending" && !firstPending) firstPending = item;
    }
    const total = activeTotal || plan.items.length;
    const allDone = total > 0 && completed >= total;
    const ratio = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    return { completed, total, inProgress, firstPending, allDone, ratio };
  }, [plan.items]);

  if (plan.items.length === 0) return null;

  const headline = stats.allDone
    ? `已完成全部 ${stats.total} 项任务`
    : stats.inProgress
      ? stats.inProgress.activeForm || stats.inProgress.content
      : stats.firstPending?.content || plan.title || "任务清单";

  return (
    <section
      className="pointer-events-auto overflow-hidden rounded-lg border border-edge bg-card shadow-md view-in-soft"
      aria-label={plan.title || "任务清单"}
    >
      <div className="flex h-10 items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={headline}
        >
          <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
            {stats.inProgress ? (
              <span className="live-dot" />
            ) : stats.allDone ? (
              <CheckCircle2 className="h-[14px] w-[14px] text-ok" />
            ) : (
              <ListTodo className="h-[14px] w-[14px] text-fg-3" />
            )}
          </span>
          <span className="shrink-0 text-label font-medium text-fg-3">
            {plan.title || "任务"}
          </span>
          <span className="min-w-0 flex-1 truncate text-body text-fg">{headline}</span>
          <span className="shrink-0 font-mono text-meta tabular-nums text-fg-3">
            {stats.completed}/{stats.total}
          </span>
          <span className="hidden h-1 w-14 shrink-0 overflow-hidden rounded-full bg-well sm:block" aria-hidden>
            <span
              className={`block h-full rounded-full transition-[width,background-color] duration-base ease-swift ${
                stats.allDone ? "bg-ok" : "bg-accent"
              }`}
              style={{ width: `${stats.ratio}%` }}
            />
          </span>
          <ChevronDown
            className={`h-[14px] w-[14px] shrink-0 text-fg-4 transition-transform duration-base ease-swift ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>

        {stats.allDone && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-4 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
            title="收起已完成任务清单"
            aria-label="收起已完成任务清单"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {open && (
        <ol className="max-h-56 space-y-1 overflow-y-auto border-t border-line px-3 py-2">
          {plan.items.map((item) => (
            <PlanItemRow key={item.id} item={item} />
          ))}
        </ol>
      )}
    </section>
  );
});

function PlanItemRow({ item }: { item: PlanItem }) {
  const isDone = item.status === "completed";
  const isRunning = item.status === "in_progress";
  const isCancelled = item.status === "cancelled";
  const prio = item.priority ? PRIORITY_LABEL[item.priority] : null;

  return (
    <li className="flex items-start gap-2 rounded-md px-2 py-1 text-body">
      <span className="mt-[3px] grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
        {isRunning ? (
          <span className="live-dot" />
        ) : isDone ? (
          <CheckCircle2 className="h-[14px] w-[14px] text-ok" />
        ) : isCancelled ? (
          <MinusCircle className="h-[14px] w-[14px] text-fg-4" />
        ) : (
          <Circle className="h-[14px] w-[14px] text-fg-4" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div
          className={`leading-snug break-words ${
            isRunning
              ? "font-medium text-fg"
              : isDone
                ? "text-fg-3 line-through decoration-line-2"
                : isCancelled
                  ? "text-fg-4 line-through"
                  : "text-fg-2"
          }`}
        >
          {item.content}
        </div>
        {isRunning && item.activeForm && item.activeForm !== item.content && (
          <div className="mt-1 text-meta text-fg-3">{item.activeForm}</div>
        )}
        {item.note && (
          <div className="mt-1 line-clamp-2 text-meta text-fg-4" title={item.note}>
            {item.note}
          </div>
        )}
        {item.blockedBy && item.blockedBy.length > 0 && !isDone && (
          <div className="mt-1 text-meta text-fg-4">依赖 #{item.blockedBy.join(", #")}</div>
        )}
      </div>

      {prio && !isDone && !isCancelled && (
        <Badge tone={prio.tone} className="mt-[2px] shrink-0">
          {prio.text}
        </Badge>
      )}
    </li>
  );
}
