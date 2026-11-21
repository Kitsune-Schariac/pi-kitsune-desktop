import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { formatDuration } from "../../../lib/timeline";
import type { ActionAnalysis } from "../../../lib/telemetry";
import type { ModelInfo } from "../../../store/session";
import { useUiStore } from "../../../store/ui";

/** 模型执行动作解析: 工程意图四类聚合 + 代码增删统计 + 健康度行 + 可折叠工具 Top + 模型元信息 */
export function ActionStrip({
  data,
  model,
  thinkingLevel,
  speed,
}: {
  data: ActionAnalysis;
  model: ModelInfo | null;
  thinkingLevel: string;
  speed: number | null;
}) {
  const [showTools, setShowTools] = useState(false);
  const openStep = useUiStore((s) => s.openStep);
  const maxCat = data.categories.length > 0 ? data.categories[0].count : 1;
  const maxTool = data.topTools.length > 0 ? data.topTools[0][1] : 1;

  return (
    <div className="tel-card">
      <div className="tel-head">
        <span className="tel-title">
          <Wrench className="h-[13px] w-[13px] text-fg-3" />
          执行动作解析
        </span>
        <span className="flex items-center gap-2 font-mono text-meta tabular-nums text-fg-3">
          {data.runningTools > 0 && <span className="live-dot" />}
          <span>{data.totalTools} 步</span>
          {data.totalDurationSec != null && <span>· {formatDuration(data.totalDurationSec)}</span>}
        </span>
      </div>

      {/* 四类意图条 */}
      {data.categories.length === 0 ? (
        <p className="mt-2 text-meta text-fg-4">本会话尚无工具动作</p>
      ) : (
        <div className="mt-2 space-y-2">
          {data.categories.map((cat) => (
            <div key={cat.key} className="space-y-1">
              <div className="flex items-center gap-2 text-meta">
                <span className="min-w-0 flex-1 truncate text-fg-2">{cat.label}</span>
                {cat.key === "edit" && (data.linesAdded > 0 || data.linesDeleted > 0) && (
                  <span className="font-mono tabular-nums">
                    <span className="text-ok">+{data.linesAdded}</span>
                    {data.linesDeleted > 0 && (
                      <span className="ml-1 text-err">−{data.linesDeleted}</span>
                    )}
                  </span>
                )}
                {cat.errors > 0 && (
                  <span className="font-mono tabular-nums text-err">{cat.errors} 错</span>
                )}
                {cat.hasDuration && cat.durationSec > 0 && (
                  <span className="font-mono tabular-nums text-fg-4">
                    {formatDuration(cat.durationSec)}
                  </span>
                )}
                <span className="w-7 text-right font-mono font-medium tabular-nums text-fg">
                  {cat.count}
                </span>
              </div>
              <div className="tel-bar-thin">
                <span
                  style={{
                    width: `${(cat.count / maxCat) * 100}%`,
                    background: cat.vizVar,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 行为健康与模型元信息紧凑行 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-meta tabular-nums text-fg-3">
        {data.thinkingRatio != null && (
          <span>
            思考占比 <b className="font-mono font-medium text-fg-2">{data.thinkingRatio.toFixed(0)}%</b>
          </span>
        )}
        {speed != null && speed > 0 && (
          <span>
            速度 <b className="font-mono font-medium text-fg-2">{speed.toFixed(0)} tok/s</b>
          </span>
        )}
        {data.errorTools > 0 && data.lastErrorStepId && (
          <button
            type="button"
            onClick={() => openStep(data.lastErrorStepId!)}
            className="flex items-center gap-1 text-err transition-opacity duration-fast ease-out hover:opacity-80"
            title="点击查看最近一次失败的工具步骤"
          >
            <AlertCircle className="h-3 w-3" />
            {data.errorTools} 次失败
          </button>
        )}
      </div>

      {/* 模型胶囊行 */}
      <div className="mt-2 flex flex-wrap items-center gap-1 text-meta">
        <span className="truncate rounded-sm bg-well px-2 py-1 font-mono text-fg-2" title={model ? `${model.provider}/${model.id}` : ""}>
          {model ? model.id : "—"}
        </span>
        {model?.provider && (
          <span className="rounded-sm bg-well px-2 py-1 text-fg-3">{model.provider}</span>
        )}
        <span className="rounded-sm bg-well px-2 py-1 text-fg-3">思考 {thinkingLevel || "medium"}</span>
      </div>

      {/* 可折叠单工具 Top 分布 */}
      {data.topTools.length > 0 && (
        <div className="mt-2 border-t border-line pt-2">
          <button
            type="button"
            onClick={() => setShowTools((v) => !v)}
            className="flex w-full items-center gap-1 text-meta text-fg-3 transition-colors duration-fast ease-out hover:text-fg"
          >
            {showTools ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span>工具调用明细 ({data.topTools.length} 种)</span>
          </button>
          {showTools && (
            <div className="mt-2 space-y-1">
              {data.topTools.map(([name, count]) => (
                <div key={name} className="ov-bar-row">
                  <span className="ov-bar-k" title={name}>{name}</span>
                  <span className="ov-bar">
                    <span style={{ width: `${(count / maxTool) * 100}%` }} />
                  </span>
                  <span className="ov-bar-v">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
