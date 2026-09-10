// 速度统计的实时累加器 —— 刻意放在 zustand 之外
//
// 为什么不用 store: message_update 是每个 token 一次的高频事件 (实测一次 300 token 的回复
// 会产生 300+ 个事件)。若每个 delta 都 patch turnStats, 会触发 zustand 通知 + InputBar
// 重渲染, 高速模型下每秒数百次 —— 这正是本任务要修的既有性能问题之一。
//
// 所以实时累加走模块级 Map (纯整数加法, 零分配零通知), 渲染侧由 InputBar 既有的 1s tick
// 主动采样 (调 liveSpeedFor)。tick 本来就在跑, 采样是纯计算, 不增加任何渲染次数。
//
// 权威结算数据 (calls) 仍写回 store 的 turnStats —— 那是低频的 (每次 LLM 调用一次)。

import { accumulateDelta, emptyCounts, liveSpeed, roundSpeed, settleCall, TOOLCALL_COEF_INIT } from "./speed";
import type { CallRecord, DeltaCounts } from "../store/session";

interface LiveState {
  counts: DeltaCounts;
  coef: number;
  genStartedAt: number | null;
  calls: CallRecord[];
}

const live = new Map<string, LiveState>();

function stateOf(sessionId: string): LiveState {
  let s = live.get(sessionId);
  if (!s) {
    s = { counts: emptyCounts(), coef: TOOLCALL_COEF_INIT, genStartedAt: null, calls: [] };
    live.set(sessionId, s);
  }
  return s;
}

/** 新一轮开始 (agent_start): 清空该会话的速度状态 */
export function startRound(sessionId: string): void {
  live.set(sessionId, { counts: emptyCounts(), coef: TOOLCALL_COEF_INIT, genStartedAt: null, calls: [] });
}

/** 会话销毁时清理, 防 Map 泄漏 */
export function dropSession(sessionId: string): void {
  live.delete(sessionId);
}

/** 会话被停/驱逐时清理实时量 (会话可能再跑, 但当前调用已中断) */
export function resetLive(sessionId: string): void {
  const s = live.get(sessionId);
  if (!s) return;
  s.counts = emptyCounts();
  s.genStartedAt = null;
}

/**
 * delta 事件 (message_update): 纯累加, 不触发任何通知。
 * 整数加法 + 一次 Map 查找, 高频路径上开销可忽略。
 */
export function noteDelta(sessionId: string, subType: string | undefined, hasDelta: boolean, now: number): void {
  const s = stateOf(sessionId);
  s.genStartedAt = accumulateDelta(s.counts, subType, hasDelta, s.genStartedAt ?? 0, now) || null;
}

/**
 * 消息结束结算: 用权威 output 校正估算, 记录本次调用。
 * 返回该会话本轮已结算的调用列表 (供 store 写回 turnStats) 与当前速度。
 */
export function settle(
  sessionId: string,
  trueOutput: number,
  now: number,
): { calls: CallRecord[]; speed: number | null; counts: DeltaCounts } {
  const s = stateOf(sessionId);
  const { record, coef } = settleCall(s.counts, s.coef, s.genStartedAt, trueOutput, now);
  s.coef = coef;
  if (record) s.calls.push(record);
  s.counts = emptyCounts();
  s.genStartedAt = null;
  return { calls: [...s.calls], speed: liveSpeed(s.calls, s.counts, s.coef, null, now), counts: s.counts };
}

/** 轮次结束 (agent_settled): 定格为加权平均 */
export function finishRound(sessionId: string): { calls: CallRecord[]; speed: number | null } | null {
  const s = live.get(sessionId);
  if (!s) return null;
  return { calls: [...s.calls], speed: roundSpeed(s.calls) };
}

/**
 * 渲染侧采样入口 (InputBar 的 1s tick 调)。
 * 优先返回实时估算; 无实时数据 (调用间隙) 时返回本轮已结算的加权平均, 避免数字闪烁成 —。
 */
export function liveSpeedFor(sessionId: string, now: number): number | null {
  const s = live.get(sessionId);
  if (!s) return null;
  const liveVal = liveSpeed(s.calls, s.counts, s.coef, s.genStartedAt, now);
  if (liveVal !== null) return liveVal;
  return roundSpeed(s.calls);
}

/** 供调试/测试读取内部状态 */
export function debugLiveState(sessionId: string): LiveState | undefined {
  const s = live.get(sessionId);
  return s ? { ...s, counts: { ...s.counts }, calls: [...s.calls] } : undefined;
}
