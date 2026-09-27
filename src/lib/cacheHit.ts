// 缓存命中率 (最近一次调用口径) 的共享计算: 检查器概览与输入卡实时栏共用同一份,
// 口径只允许存在一处 —— 两处各自内联的写法曾在阶段 3 被指出有漂移风险。
//
// 缓存命中率 (最近一次调用口径): cacheRead ÷ (input + cacheRead + cacheWrite),
// 缓存写入按未命中计。与 TUI footer 同口径, 详见 pi-kitsune-ui/src/footer.ts 的 cacheHitRate。
// 显示条件沿用 pi 官方 footer 的双重判定:
//   ① 会话出现过缓存活动 —— 过滤「provider 根本不支持缓存」的情况, 那种场景显示 0%
//      会被误读成「缓存失效了」, 而事实是从未有过缓存；
//      本轮 cacheSeen 是同一个信号的提前量 (会话累计到 agent_settled 才刷新, 首轮靠它兜底)
//   ② 最近一次有 prompt 量 —— 保证分母非 0, 不产生 NaN
import type { SessionState, TurnStats } from "../store/session";

type TokenStats = NonNullable<SessionState["tokenStats"]>;

export function cacheHitRate(
  turnStats: TurnStats | null,
  tokenStats: TokenStats | null,
): number | null {
  const lastCache = turnStats?.lastCache ?? null;
  const cacheActive =
    (turnStats?.cacheSeen ?? false) ||
    (tokenStats?.tokens.cacheRead ?? 0) > 0 ||
    (tokenStats?.tokens.cacheWrite ?? 0) > 0;
  const cachePromptTokens = lastCache ? lastCache.input + lastCache.cacheRead + lastCache.cacheWrite : 0;
  return lastCache && cacheActive && cachePromptTokens > 0
    ? (lastCache.cacheRead / cachePromptTokens) * 100
    : null;
}
