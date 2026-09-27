import { useEffect, useRef } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowLeft, Bot, Copy, Crosshair, FilePenLine, FilePlus2, FileText, Radar, Terminal, Wrench,
} from "lucide-react";
import type { ChatEntry } from "../../store/session";
import { useUiStore } from "../../store/ui";
import { useFleetStore } from "../../store/fleet";
import { DiffView, PlainDiffView } from "../DiffView";
import {
  SUBAGENT_TOOLS, extractAgentFromArgs, extractDiff, extractResultText,
  extractSubagentDetails, formatDuration, stepDiffStat, stepDuration,
} from "../../lib/timeline";

const TOOL_ICONS: Record<string, typeof Wrench> = {
  bash: Terminal,
  write: FilePlus2,
  edit: FilePenLine,
  read: FileText,
  subagent: Bot,
  subagent_wait: Bot,
};

// 输出/进度区展示行数上限: 几万行的工具输出全量渲染会拖垮面板, 只展示前 400 行
const OUT_LIMIT = 400;

/**
 * 检查器「详情」页签的步骤视图: bash / write / 带 diff 的 edit / subagent 四类专用呈现,
 * 其余工具给参数 + 结果。数据全部来自 entry (args / result / 计时), 不额外拉取。
 * onBack / hideLocate 供舰队子会话就地展开时覆盖全局行为 (缺省保持检查器主路径不变)。
 */
export function StepDetail({
  entry,
  cwd,
  onBack,
  hideLocate,
}: {
  entry: ChatEntry;
  cwd?: string;
  /** 返回按钮回调; 缺省回检查器概览 (全局 clearStep), 舰队子会话传收起 */
  onBack?: () => void;
  /** 子会话步骤不属于主时间线, 舰队面板内隐藏「在时间线定位」 */
  hideLocate?: boolean;
}) {
  const clearStep = useUiStore((s) => s.clearStep);
  const locateStep = useUiStore((s) => s.locateStep);

  const Icon = TOOL_ICONS[entry.toolName ?? ""] ?? Wrench;
  const resultText = entry.result ? extractResultText(entry.result) : "";
  const diff = entry.result ? extractDiff(entry.result) : null;
  const subagentDetails = entry.result ? extractSubagentDetails(entry.result) : null;
  const isSubagent = SUBAGENT_TOOLS.has(entry.toolName ?? "") || !!subagentDetails;
  const isBash = entry.toolName === "bash";
  const seconds = stepDuration(entry);
  const diffStat = stepDiffStat(entry);

  const args = (entry.args && typeof entry.args === "object" ? entry.args : null) as {
    command?: unknown; path?: unknown; file_path?: unknown; content?: unknown;
  } | null;
  const command = isBash && typeof args?.command === "string" ? args.command : "";
  const isWrite = entry.toolName === "write";
  const filePath =
    typeof args?.path === "string"
      ? args.path
      : typeof args?.file_path === "string"
        ? args.file_path
        : "";
  const writeContent = isWrite && typeof args?.content === "string" ? args.content : "";
  const agentName = extractAgentFromArgs(entry.args) || subagentDetails?.agent || entry.toolName || "";
  const argsStr = entry.args
    ? typeof entry.args === "string"
      ? entry.args
      : JSON.stringify(entry.args, null, 2)
    : "";

  // 长输出截断 (命令输出与结果文本共用同一口径)
  const outLines = resultText ? resultText.split("\n") : [];
  const truncated = outLines.length > OUT_LIMIT;
  const outText = truncated ? outLines.slice(0, OUT_LIMIT).join("\n") : resultText;

  // subagent 运行中的进度区自动滚底, 始终显示最新一行
  const progressRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (entry.status === "running" && progressRef.current) {
      progressRef.current.scrollTop = progressRef.current.scrollHeight;
    }
  }, [entry.status, resultText]);

  const copy = async () => {
    const text = isBash ? command : resultText;
    if (!text) return;
    try {
      // 走 clipboard-manager 插件而非 navigator.clipboard: 后者在 WebView2 里会弹剪贴板权限询问
      await writeText(text);
    } catch (e) {
      // 复制失败不打断阅读 (如剪贴板被占用), 此处没有错误展示位, 记日志即可
      console.error("复制失败", e);
    }
  };

  const statusLabel =
    entry.status === "error" ? "失败" : entry.status === "running" ? "运行中" : "完成";

  return (
    <section className="sd">
      <button type="button" className="sd-back" onClick={onBack ?? clearStep}>
        <ArrowLeft className="h-3 w-3" />
        概览
      </button>

      <header className="sd-head">
        <div className="sd-title">
          <Icon className="sd-tool" />
          <span className="sd-name">{entry.toolName}</span>
          <span className={`sd-status ${entry.status ?? "done"}`}>{statusLabel}</span>
        </div>
        <div className="sd-meta">
          {seconds != null && <span>{formatDuration(seconds)}</span>}
          {diffStat && (
            <span>
              <b className="tl-plus">+{diffStat.add}</b>
              {diffStat.del > 0 && <i className="tl-minus">−{diffStat.del}</i>}
            </span>
          )}
        </div>
      </header>

      {isSubagent ? (
        <>
          <div className="sd-sec">
            <div className="sd-label">
              子 agent <span className="sd-mono">{agentName}</span>
            </div>
            {subagentDetails && subagentDetails.durationMs != null && (
              <div className="sd-kv">
                <span>耗时</span>
                <b className="sd-mono">{(subagentDetails.durationMs / 1000).toFixed(1)}s</b>
              </div>
            )}
            {subagentDetails && subagentDetails.costUsd != null && (
              <div className="sd-kv">
                <span>花费</span>
                <b className="sd-mono">${subagentDetails.costUsd.toFixed(2)}</b>
              </div>
            )}
            {subagentDetails && subagentDetails.runId && (
              <div className="sd-kv">
                <span>runId</span>
                <b className="sd-mono">{subagentDetails.runId}</b>
              </div>
            )}
          </div>
          {/* 参数（含 task 全文）保留展示: 摘要是截断过的, 这里是不丢信息的地方 */}
          {argsStr && (
            <div className="sd-sec">
              <div className="sd-label">参数</div>
              <pre className="sd-code">{argsStr}</pre>
            </div>
          )}
          {entry.status === "running" && resultText && (
            <div className="sd-sec">
              <div className="sd-label">进度</div>
              <pre ref={progressRef} className="sd-code out">
                {resultText}
              </pre>
            </div>
          )}
          {/* 运行中进度已展示, 完成后同一份 result 就是产物文本, 不重复渲染 */}
          {entry.status !== "running" && resultText && !diff && (
            <div className="sd-sec">
              <div className="sd-label">结果</div>
              <pre className="sd-code out">{outText}</pre>
            </div>
          )}
          {diff?.patch && <DiffView patch={diff.patch} cwd={cwd} />}
          {!diff?.patch && diff?.diff && <PlainDiffView text={diff.diff} />}
        </>
      ) : isBash ? (
        <>
          <div className="sd-sec">
            <div className="sd-label">命令</div>
            <pre className="sd-code cmd">{command}</pre>
          </div>
          <div className="sd-sec">
            <div className="sd-label">
              输出
              {truncated && <span className="sd-more">另有 {outLines.length - OUT_LIMIT} 行</span>}
            </div>
            <pre className={`sd-code out${entry.status === "error" ? " is-err" : ""}`}>{outText}</pre>
          </div>
        </>
      ) : isWrite ? (
        <div className="sd-sec">
          <div className="sd-label">
            新文件 <span className="sd-mono">{filePath}</span>
          </div>
          <pre className="sd-code diff">
            {writeContent.split("\n").map((line, i) => (
              <span key={i} className="add">
                + {line}
              </span>
            ))}
          </pre>
        </div>
      ) : diff?.patch ? (
        <div className="sd-sec">
          <div className="sd-label">
            变更 {filePath && <span className="sd-mono">{filePath}</span>}
          </div>
          <DiffView patch={diff.patch} cwd={cwd} />
        </div>
      ) : diff?.diff ? (
        <div className="sd-sec">
          <div className="sd-label">变更</div>
          <PlainDiffView text={diff.diff} />
        </div>
      ) : (
        <>
          {argsStr && (
            <div className="sd-sec">
              <div className="sd-label">参数</div>
              <pre className="sd-code">{argsStr}</pre>
            </div>
          )}
          {resultText && (
            <div className="sd-sec">
              <div className="sd-label">
                结果
                {truncated && <span className="sd-more">另有 {outLines.length - OUT_LIMIT} 行</span>}
              </div>
              <pre className="sd-code out">{outText}</pre>
            </div>
          )}
        </>
      )}

      <div className="sd-actions">
        <button type="button" className="sd-action" onClick={copy} disabled={!command && !resultText}>
          <Copy className="h-3 w-3" />
          复制
        </button>
        {!hideLocate && (
          <button type="button" className="sd-action" onClick={locateStep}>
            <Crosshair className="h-3 w-3" />
            在时间线定位
          </button>
        )}
        {isSubagent && (
          <button
            type="button"
            className="sd-action"
            onClick={() => useFleetStore.getState().requestOpenPanel()}
          >
            <Radar className="h-3 w-3" />
            在舰队中查看
          </button>
        )}
      </div>
    </section>
  );
}
