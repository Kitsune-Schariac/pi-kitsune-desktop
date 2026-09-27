import { useMemo } from "react";
import { MousePointerClick } from "lucide-react";
import { useSessionStore } from "../../store/session";
import { cacheHitRate } from "../../lib/cacheHit";
import { groupStats } from "../../lib/timeline";

/** token 数缩写: 12.3k / 1.2M (千位以下原样; 概览是粗读数字, 不铺满千分位) */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * 检查器「详情」页签的会话概览 (未选中步骤时显示)。
 * 数据全部来自当前会话 store, 不额外拉取: 花费/消息数 (tokenStats), 四格 (tokenStats + contextUsage),
 * 模型三行 (currentModel / thinkingLevel), 工具分布 (entries 内的 tool 条目统计)。
 * 订阅用细粒度 selector —— 流式期间只有 tool 分布与缓存命中两处会跟着新条目重算。
 */
export function SessionOverview() {
  // store 条目为 null 时统一显示「—」, 不编造数字 (会话刚开始 / 统计未回推)
  const tokenStats = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.tokenStats ?? null : null;
  });
  const contextUsage = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.contextUsage ?? null : null;
  });
  const currentModel = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.currentModel ?? null : null;
  });
  const thinkingLevel = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.thinkingLevel : "medium";
  });
  const turnStats = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.turnStats ?? null : null;
  });
  const entries = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.entries : undefined;
  });

  // 工具分布: 整个会话的全部 tool 条目, 复用 groupStats 的计数口径 (与步骤组同一份实现);
  // groupStats 按首次出现顺序, 概览改按次数降序更直观
  const toolStats = useMemo(() => {
    const tools = entries ? entries.filter((e) => e.kind === "tool") : [];
    const stats = groupStats(tools);
    return { tools: [...stats.tools].sort((a, b) => b[1] - a[1]), errors: stats.errors };
  }, [entries]);

  const maxToolCount = toolStats.tools.length > 0 ? toolStats.tools[0][1] : 1;
  const hitRate = cacheHitRate(turnStats, tokenStats);
  // 与输入卡上下文格同口径: tokens / contextWindow (均按 k 取整展示)
  const ctxTitle = contextUsage
    ? `上下文 ${Math.round((contextUsage.tokens ?? 0) / 1000)}k / ${Math.round(contextUsage.contextWindow / 1000)}k tokens`
    : "暂无上下文统计";
  const ctxPercent = contextUsage?.percent != null ? `${Math.round(contextUsage.percent)}%` : "—";

  return (
    <section className="ov">
      <div className="ov-hero">
        <span className="ov-k">本会话花费</span>
        <span className="ov-cost">
          {tokenStats ? (
            <>
              <small>$</small>
              {tokenStats.cost.toFixed(4)}
            </>
          ) : (
            "—"
          )}
        </span>
        <span className="ov-sub">
          {tokenStats
            ? `${tokenStats.userMessages} 轮 · ${tokenStats.totalMessages} 条消息`
            : "尚无统计数据"}
        </span>
      </div>

      <div className="ov-grid">
        <div className="ov-cell">
          <span className="ov-k">输入</span>
          <span className="ov-v">{tokenStats ? fmtTokens(tokenStats.tokens.input) : "—"}</span>
        </div>
        <div className="ov-cell">
          <span className="ov-k">输出</span>
          <span className="ov-v">{tokenStats ? fmtTokens(tokenStats.tokens.output) : "—"}</span>
        </div>
        <div className="ov-cell">
          <span className="ov-k">缓存命中</span>
          <span className="ov-v" title={hitRate === null ? "当前模型未报告缓存" : "最近一次调用口径: 缓存读 ÷ (输入 + 缓存读 + 缓存写)"}>
            {hitRate === null ? "—" : `${hitRate.toFixed(1)}%`}
          </span>
        </div>
        <div className="ov-cell">
          <span className="ov-k">上下文</span>
          <span className="ov-v" title={ctxTitle}>
            {ctxPercent}
          </span>
        </div>
      </div>

      <div className="ov-sec">
        <div className="ov-title">模型</div>
        <div className="ov-kv">
          <span>供应商</span>
          <b>{currentModel?.provider ?? "—"}</b>
        </div>
        <div className="ov-kv">
          <span>模型</span>
          <b className="mono">{currentModel?.id ?? "—"}</b>
        </div>
        <div className="ov-kv">
          <span>思考级别</span>
          <b>{thinkingLevel ?? "medium"}</b>
        </div>
      </div>

      <div className="ov-sec">
        <div className="ov-title">工具分布</div>
        {toolStats.tools.length === 0 ? (
          <p className="ov-none">还没有工具调用</p>
        ) : (
          toolStats.tools.map(([name, count]) => (
            <div key={name} className="ov-bar-row">
              <span className="ov-bar-k">{name}</span>
              <span className="ov-bar">
                <span style={{ width: `${(count / maxToolCount) * 100}%` }} />
              </span>
              <span className="ov-bar-v">{count}</span>
            </div>
          ))
        )}
        {toolStats.errors > 0 && <p className="ov-err">{toolStats.errors} 次失败</p>}
      </div>

      <p className="ov-hint">
        <MousePointerClick className="h-3 w-3" />
        点时间线上任意一步，在这里看它的命令、输出和 diff
      </p>
    </section>
  );
}
