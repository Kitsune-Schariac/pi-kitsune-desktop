import { memo, useEffect, useState } from "react";
import {
  Bot, ChevronDown, FilePenLine, FilePlus2, FileText, Radar, Terminal, Wrench, X,
} from "lucide-react";
import type { ChatEntry } from "../../store/session";
import { useFleetStore } from "../../store/fleet";
import { useUiStore } from "../../store/ui";
import {
  SUBAGENT_TOOLS, extractAgentFromArgs, extractResultText, extractSubagentDetails,
  formatDuration, groupStats, stepDiffStat, stepDuration, summarizeStep,
} from "../../lib/timeline";

const TOOL_ICONS: Record<string, typeof Wrench> = {
  bash: Terminal,
  write: FilePlus2,
  edit: FilePenLine,
  read: FileText,
  subagent: Bot,
  subagent_wait: Bot,
};

interface StepGroupProps {
  entries: ChatEntry[];
  selectedId: string | null;
  /** 「在时间线定位」信号 (递增): 本组含目标步骤时强制展开, 否则折叠组里找不到行 */
  revealSeq: number;
}

/**
 * 连续工具调用聚合的步骤组: 头 = 执行 N 步 + 工具分布 + 失败数 + 总耗时。
 * 含失败或运行中的组默认展开 (失败必须浮出来), 其余默认折叠; 用户手动开合后由本地 state 记忆。
 * 工坊展开为一步一行, 舞台为一直展开的胶囊串 (index.css 按 data-style 分支)。
 */
export const StepGroup = memo(function StepGroup({ entries, selectedId, revealSeq }: StepGroupProps) {
  const stats = groupStats(entries);
  const [open, setOpen] = useState(stats.errors > 0 || stats.running);

  useEffect(() => {
    if (revealSeq > 0 && selectedId && entries.some((e) => e.id === selectedId)) setOpen(true);
  }, [revealSeq, selectedId, entries]);

  const toolText = stats.tools
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(" · ");

  return (
    <section
      className={`tl-steps${open ? " open" : ""}${stats.errors ? " has-err" : ""}${
        stats.running ? " running" : ""
      }`}
    >
      <button
        type="button"
        className="tl-steps-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tl-node" aria-hidden />
        <span className="tl-steps-title">
          {stats.running ? "执行中" : "执行"} {entries.length} 步
        </span>
        <span className="tl-steps-tools">{toolText}</span>
        {stats.errors > 0 && <span className="tl-steps-err">{stats.errors} 失败</span>}
        {/* 运行中不写耗时: 组还没跑完, 写部分和只会误导 */}
        {!stats.running && stats.total != null && (
          <span className="tl-steps-dur">{formatDuration(stats.total)}</span>
        )}
        <ChevronDown className="tl-chev h-3 w-3" />
      </button>
      <ol className="tl-steps-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <StepRow entry={entry} selected={entry.id === selectedId} />
          </li>
        ))}
      </ol>
    </section>
  );
}, sameGroupProps);

function sameGroupProps(a: StepGroupProps, b: StepGroupProps): boolean {
  if (a.selectedId !== b.selectedId || a.revealSeq !== b.revealSeq) return false;
  if (a.entries === b.entries) return true;
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) {
    if (a.entries[i] !== b.entries[i]) return false;
  }
  return true;
}

/** 单步一行。不订阅任何 store: 选中态由父级传入, 联动按钮用 getState 直调 */
function StepRow({ entry, selected }: { entry: ChatEntry; selected: boolean }) {
  const Icon = TOOL_ICONS[entry.toolName ?? ""] ?? Wrench;
  const subagentDetails = entry.result ? extractSubagentDetails(entry.result) : null;
  const isSubagent = SUBAGENT_TOOLS.has(entry.toolName ?? "") || !!subagentDetails;
  const agentName = extractAgentFromArgs(entry.args) || subagentDetails?.agent || entry.toolName || "";
  const resultText = entry.result ? extractResultText(entry.result) : "";
  // subagent 运行中: 摘要换成结果文本最后一行 (partialResult 已由 session 管道累计进 result);
  // 完成后摘要只留 agent 名, 任务描述走 title (行宽有限, 全名悬停可见)
  const progressTail = resultText.split("\n").pop()?.trim() ?? "";
  const summary = isSubagent
    ? entry.status === "running"
      ? progressTail || agentName
      : agentName
    : summarizeStep(entry);
  const subagentCost =
    subagentDetails && subagentDetails.costUsd != null ? subagentDetails.costUsd : null;
  const diff = stepDiffStat(entry);

  return (
    <div className={`tl-step-row${selected ? " sel" : ""}${entry.status === "error" ? " err" : ""}`}>
      <button
        type="button"
        className="tl-step-main"
        data-step-id={entry.id}
        title={isSubagent ? summarizeStep(entry) : summary}
        onClick={() => useUiStore.getState().openStep(entry.id)}
      >
        <span className="tl-step-status">
          {entry.status === "running" ? (
            <span className="flame" aria-hidden />
          ) : entry.status === "error" ? (
            <X className="h-3 w-3" />
          ) : (
            <span className="tl-step-dot" aria-hidden />
          )}
        </span>
        <Icon className="tl-step-icon h-[14px] w-[14px]" />
        <span className="tl-step-name">{entry.toolName}</span>
        <span className="tl-step-sum">{summary}</span>
        <span className="tl-step-extra">
          {isSubagent ? (
            subagentCost != null ? (
              `$${subagentCost.toFixed(2)}`
            ) : null
          ) : (
            diff && (
              <>
                <b className="tl-plus">+{diff.add}</b>
                {diff.del > 0 && <i className="tl-minus">−{diff.del}</i>}
              </>
            )
          )}
        </span>
        <span className="tl-step-dur">{formatDuration(stepDuration(entry))}</span>
      </button>
      {/* subagent 行尾联动: 点开检查器舰队页签; 高频组件不订阅 store, 只触发 */}
      {isSubagent && (
        <button
          type="button"
          className="tl-step-fleet"
          title="在舰队中查看"
          aria-label="在舰队中查看"
          onClick={() => useFleetStore.getState().requestOpenPanel()}
        >
          <Radar className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
