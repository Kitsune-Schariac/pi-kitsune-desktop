// 输出速度 (tok/s) 统计 —— 纯函数模块, 无 store 依赖, 便于离线验证
//
// 口径依据见 .trellis/tasks/09-10-tok-speed-tui-gui/design.md
//
// 为什么不用 usage 算实时速度: 实测 (探针录制) provider 在流式期间上报的 usage 恒为 0,
// 只在 text_end/thinking_end 时刻一次性给出真值 —— RPC 侧 169 个 message_update 中仅 1 个非零。
// 所以实时值只能估算。
//
// 为什么用 delta 计数而非字符数: 实测 text_delta/thinking_delta 的事件计数与 output token
// 精确 1:1 (301→301, 296→297, 48→48); 而字符/token 比率随内容剧变 (文本 1.68 / 工具参数 0.75 /
// 中文≈1.54 / 英文≈4), 字符估算实测误差达 -43%。delta 计数估算实测误差 < 0.3%。

import type { CallRecord, DeltaCounts } from "../store/session";

/** toolcall_delta 的 token 系数: JSON 参数每个 delta 约合 2.9 token (实测), 文本类为 1.0 */
export const TOOLCALL_COEF_INIT = 2.9;
/** 自校正的最小样本量: 少于这个数反推系数噪声太大, 不更新 */
const COEF_MIN_SAMPLES = 10;
/** 累计生成窗口下限 (秒): 短于此值不报速度, 极早期单 delta 抖动会放大成巨大数值 */
const MIN_WINDOW_S = 0.2;

export function emptyCounts(): DeltaCounts {
  return { thinking: 0, text: 0, toolcall: 0 };
}

/**
 * delta 事件累计。纯整数加法 —— message_update 是每个 token 一次的高频路径,
 * 这里不做任何分配/渲染, 避免拖慢流式。
 * @param counts 就地累加的计数对象
 * @param subType assistantMessageEvent.type
 * @param hasDelta 是否带真实内容 (start/end 这类不带, 不该开启计时窗口)
 * @param genStartedAt 当前调用起点 (0 = 未开始), 返回更新后的值
 * @param now 当前时间戳
 */
export function accumulateDelta(
  counts: DeltaCounts,
  subType: string | undefined,
  hasDelta: boolean,
  genStartedAt: number,
  now: number,
): number {
  if (subType === "thinking_delta") counts.thinking++;
  else if (subType === "text_delta") counts.text++;
  else if (subType === "toolcall_delta") counts.toolcall++;
  else return genStartedAt;
  // 只认真正带内容的 delta 开启计时窗口
  return hasDelta && !genStartedAt ? now : genStartedAt;
}

/** 当前调用的估算 token 数 */
export function estimateTokens(counts: DeltaCounts, coef: number): number {
  return counts.thinking + counts.text + counts.toolcall * coef;
}

/** 当前调用的生成窗口 (秒) */
export function windowSeconds(genStartedAt: number | null, now: number): number {
  if (!genStartedAt) return 0;
  return (now - genStartedAt) / 1000;
}

/**
 * 实时速度 (tok/s), 本轮累计口径。
 *
 * 用「已结算调用 + 当前累积调用」的合计而非只看当前调用: 工具调用场景下单次窗口
 * 常短到 0.1~0.3s (实测), 单次口径会持续触发阈值保护而满屏 "—"; 累计口径始终有值
 * 且天然平滑, 与统计条其余四项 (input/output/cost/耗时) 的本轮累计语义一致。
 */
export function liveSpeed(
  calls: CallRecord[],
  counts: DeltaCounts,
  coef: number,
  genStartedAt: number | null,
  now: number,
): number | null {
  let out = 0;
  let win = 0;
  for (const c of calls) {
    out += c.output;
    win += c.window;
  }
  const curWin = windowSeconds(genStartedAt, now);
  if (curWin > 0) {
    out += estimateTokens(counts, coef);
    win += curWin;
  }
  if (win < MIN_WINDOW_S || out <= 0) return null;
  return out / win;
}

/**
 * 本轮加权平均速度 Σoutput ÷ Σwindow (轮次结束后定格用)。
 * 用加权而非算术平均 —— 长输出调用应占更大权重, 否则 5 token 的短回复
 * 会跟 3000 token 的长输出等权, 严重失真。
 */
export function roundSpeed(calls: CallRecord[]): number | null {
  let out = 0;
  let win = 0;
  for (const c of calls) {
    out += c.output;
    win += c.window;
  }
  if (win <= 0 || out <= 0) return null;
  return out / win;
}

/**
 * 消息结束结算: 用权威 usage.output 校正估算。
 * 返回本次调用是否有效 + 更新后的 toolcall 系数 (自适应不同 provider)。
 */
export function settleCall(
  counts: DeltaCounts,
  coef: number,
  genStartedAt: number | null,
  trueOutput: number,
  now: number,
): { record: CallRecord | null; coef: number } {
  // output 为 0 (报错/中止/纯工具无输出) 不参与统计, 否则污染加权平均
  if (trueOutput <= 0 || !genStartedAt) return { record: null, coef };
  const win = windowSeconds(genStartedAt, now);
  if (win <= 0) return { record: null, coef };

  let nextCoef = coef;
  // 系数自校正: 从权威值反推 toolcall 的实际系数, 指数滑动平均避免单次噪声跳变
  if (counts.toolcall >= COEF_MIN_SAMPLES) {
    const textPart = counts.thinking + counts.text;
    const observed = (trueOutput - textPart) / counts.toolcall;
    if (observed > 0.5 && observed < 20) {
      nextCoef = 0.7 * coef + 0.3 * observed;
    }
  }
  return { record: { output: trueOutput, window: win }, coef: nextCoef };
}
