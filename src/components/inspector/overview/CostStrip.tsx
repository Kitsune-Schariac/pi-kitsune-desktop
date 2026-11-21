import { Coins, Sparkles } from "lucide-react";
import { fmtUsd, type CostAnalysis } from "../../../lib/telemetry";

/** 费用解析: 紧凑总览行 (总计 / 本轮 / 轮均) + 四分项费用条 + 缓存节省徽标 */
export function CostStrip({
  data,
  turns,
  totalMessages,
}: {
  data: CostAnalysis;
  turns: number;
  totalMessages: number;
}) {
  return (
    <div className="tel-card">
      <div className="tel-head">
        <span className="tel-title">
          <Coins className="h-[13px] w-[13px] text-fg-3" />
          费用解析
          {data.estimated && (
            <span className="rounded-sm bg-well px-1 text-meta font-normal text-fg-4" title="基于 models.json 单价推算">
              估算
            </span>
          )}
        </span>
        <span className="font-mono text-lead font-semibold tabular-nums text-fg">
          {fmtUsd(data.total)}
        </span>
      </div>

      {/* 本轮 / 轮均 / 轮数 紧凑三列 */}
      <div className="mt-2 grid grid-cols-3 gap-2 rounded-sm bg-well px-2 py-2 text-meta tabular-nums">
        <div className="flex flex-col">
          <span className="text-fg-4">本轮</span>
          <span className="font-mono font-medium text-fg-2">{fmtUsd(data.turnCost)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-fg-4">轮均</span>
          <span className="font-mono font-medium text-fg-2">{fmtUsd(data.avgTurnCost)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-fg-4">对话</span>
          <span className="font-mono font-medium text-fg-2">
            {turns > 0 ? `${turns} 轮` : "—"}
            {totalMessages > 0 ? ` · ${totalMessages}` : ""}
          </span>
        </div>
      </div>

      {/* 分项费用构成 */}
      {data.items.length > 0 && (
        <>
          <div className="tel-bar mt-3">
            {data.items
              .filter((it) => it.cost > 0)
              .map((it) => (
                <span
                  key={it.key}
                  className="tel-bar-seg"
                  style={{ width: `${Math.max(it.percent, 1)}%`, background: it.vizVar }}
                  title={`${it.label}: ${fmtUsd(it.cost)} (${it.percent.toFixed(1)}%)`}
                />
              ))}
          </div>
          <div className="mt-2 space-y-1">
            {data.items.map((it) => (
              <div key={it.key} className="flex items-center gap-2 text-meta">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: it.vizVar }}
                />
                <span className="min-w-0 flex-1 truncate text-fg-2">{it.label}</span>
                <span className="font-mono tabular-nums text-fg">{fmtUsd(it.cost)}</span>
                <span className="w-10 text-right font-mono tabular-nums text-fg-4">
                  {it.percent >= 0.1 || it.cost === 0 ? `${it.percent.toFixed(0)}%` : "<1%"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 缓存节省提示 */}
      {data.cacheSavedUsd != null && (
        <div className="mt-3 flex items-center gap-2 rounded-sm bg-well px-2 py-2 text-meta text-ok">
          <Sparkles className="h-[13px] w-[13px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            缓存命中预计节省{" "}
            <b className="font-mono font-semibold tabular-nums">{fmtUsd(data.cacheSavedUsd)}</b>
            {data.cacheSavedPercent != null && (
              <span className="ml-1 font-mono tabular-nums text-fg-3">
                (-{data.cacheSavedPercent.toFixed(0)}%)
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
