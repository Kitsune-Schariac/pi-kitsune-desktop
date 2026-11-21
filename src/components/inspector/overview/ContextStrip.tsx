import { Layers } from "lucide-react";
import { fmtTokens, type ContextAnalysis } from "../../../lib/telemetry";

/** 上下文窗口解剖: 健康度条 + 成分估算构成条 + 剩余空间提示 */
export function ContextStrip({ data }: { data: ContextAnalysis }) {
  const pct = data.percent != null ? Math.round(data.percent) : null;
  const barTone =
    data.level === "danger"
      ? "bg-err"
      : data.level === "warn"
        ? "bg-warn"
        : "bg-accent";
  const pctTone =
    data.level === "danger"
      ? "text-err"
      : data.level === "warn"
        ? "text-warn"
        : "text-fg";

  return (
    <div className="tel-card">
      <div className="tel-head">
        <span className="tel-title">
          <Layers className="h-[13px] w-[13px] text-fg-3" />
          上下文窗口
        </span>
        <span className={`font-mono text-body font-semibold tabular-nums ${pctTone}`}>
          {pct != null ? `${pct}%` : "—"}
        </span>
      </div>

      {/* 主进度条: 有成分拆解时用多段彩色叠加, 无拆解时用单色进度条 */}
      <div
        className="tel-bar mt-2"
        title={
          data.used != null && data.window > 0
            ? `已用 ${data.used.toLocaleString()} / ${data.window.toLocaleString()} tokens`
            : "暂无上下文窗口数据"
        }
      >
        {data.hasBreakdown && data.window > 0 ? (
          data.segments.map((seg) => (
            <span
              key={seg.key}
              className="tel-bar-seg"
              style={{
                width: `${Math.max(seg.shareOfWindow, 0.8)}%`,
                background: seg.vizVar,
              }}
              title={`${seg.label}: 约 ${fmtTokens(seg.estTokens)} (${seg.shareOfUsed.toFixed(0)}%)`}
            />
          ))
        ) : (
          <span
            className={`tel-bar-seg ${barTone}`}
            style={{ width: `${data.percent ?? 0}%` }}
          />
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-meta tabular-nums text-fg-3">
        <span>
          {data.used != null && data.window > 0
            ? `${fmtTokens(data.used)} / ${fmtTokens(data.window)}`
            : "暂无上下文统计"}
        </span>
        {data.remaining != null && (
          <span className={data.level === "danger" ? "text-err" : "text-fg-4"}>
            {data.level === "danger" ? "逼近压缩 · " : ""}剩余 {fmtTokens(data.remaining)}
          </span>
        )}
      </div>

      {data.hasBreakdown && (
        <div className="mt-3 space-y-1 border-t border-line pt-2">
          {data.segments.map((seg) => (
            <div key={seg.key} className="flex items-center gap-2 text-meta">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: seg.vizVar }}
              />
              <span className="min-w-0 flex-1 truncate text-fg-2">{seg.label}</span>
              <span className="font-mono tabular-nums text-fg-3">~{fmtTokens(seg.estTokens)}</span>
              <span className="w-9 text-right font-mono tabular-nums text-fg-4">
                {seg.shareOfUsed.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
