import { Cpu } from "lucide-react";
import { fmtTokens, type TokenAnalysis } from "../../../lib/telemetry";

/** Token 四分项构成解析: 缓存命中读 / 未命中输入 / 缓存写入 / 模型输出 + 双口径命中率 */
export function TokenStrip({ data }: { data: TokenAnalysis }) {
  return (
    <div className="tel-card">
      <div className="tel-head">
        <span className="tel-title">
          <Cpu className="h-[13px] w-[13px] text-fg-3" />
          Token 构成
        </span>
        <span className="font-mono text-label font-medium tabular-nums text-fg-2">
          {data.hasData ? fmtTokens(data.total) : "—"}
        </span>
      </div>

      {/* 四色堆叠条 */}
      <div className="tel-bar mt-2">
        {data.hasData &&
          data.buckets
            .filter((b) => b.tokens > 0)
            .map((b) => (
              <span
                key={b.key}
                className="tel-bar-seg"
                style={{ width: `${Math.max(b.percent, 1)}%`, background: b.vizVar }}
                title={`${b.label}: ${b.tokens.toLocaleString()} (${b.percent.toFixed(1)}%)`}
              />
            ))}
      </div>

      {/* 缓存命中率双指标胶囊 */}
      <div className="mt-2 flex items-center justify-between gap-2 text-meta tabular-nums">
        <span
          className="text-fg-3"
          title="最近一次 LLM 调用的缓存命中率: cacheRead / (input + cacheRead + cacheWrite)"
        >
          最近命中{" "}
          <b className={`font-mono font-medium ${data.lastHitRate != null ? "text-ok" : "text-fg-4"}`}>
            {data.lastHitRate != null ? `${data.lastHitRate.toFixed(1)}%` : "—"}
          </b>
        </span>
        <span
          className="text-fg-3"
          title="整会话累计缓存命中率: 累计 cacheRead / 累计请求侧 tokens"
        >
          累计命中{" "}
          <b className={`font-mono font-medium ${data.sessionHitRate != null ? "text-fg" : "text-fg-4"}`}>
            {data.sessionHitRate != null ? `${data.sessionHitRate.toFixed(1)}%` : "—"}
          </b>
        </span>
      </div>

      {/* 四项明细表 */}
      {data.hasData ? (
        <div className="mt-3 space-y-1 border-t border-line pt-2">
          {data.buckets.map((b) => (
            <div key={b.key} className="flex items-center gap-2 text-meta">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: b.vizVar }}
              />
              <span className="min-w-0 flex-1 truncate text-fg-2">{b.label}</span>
              <span className="font-mono tabular-nums text-fg">
                {fmtTokens(b.tokens)}
              </span>
              <span className="w-10 text-right font-mono tabular-nums text-fg-4">
                {b.percent >= 0.1 || b.tokens === 0 ? `${b.percent.toFixed(1)}%` : "<0.1%"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-meta text-fg-4">尚无 Token 用量数据</p>
      )}
    </div>
  );
}
