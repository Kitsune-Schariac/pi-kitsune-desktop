// token 数量的输入解析与显示格式 (设置窗模型编辑器: 上下文窗口 / 最大输出)。
// models.json 里存的是精确整数, 用户习惯写 200k / 1M / 20万, 两边在这里互转。

const UNIT: Record<string, number> = { "": 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, 万: 1e4 };

/**
 * `200000` / `200k` / `1.2M` / `20万` → 整数 token 数。
 * 空串返回 null (未设置); 无法识别或不是正数返回 NaN, 调用方据此标红且不落盘。
 */
export function parseTokenCount(text: string): number | null {
  const t = text.trim().replace(/[,_\s]/g, "");
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)([kKmM万]?)$/.exec(t);
  if (!m) return NaN;
  const n = Math.round(parseFloat(m[1]) * UNIT[m[2]]);
  return n > 0 ? n : NaN;
}

/**
 * 输入框回显: 只在整除时写成简写。131072 这类值原样显示,
 * 写成「131k」会被读成 131000 再存回去, 静默改掉用户的配置。
 */
export function formatTokenExact(v: unknown): string {
  if (typeof v !== "number" || !(v > 0)) return "";
  if (v >= 1e6 && v % 1e4 === 0) return `${v / 1e6}M`;
  if (v % 1000 === 0) return `${v / 1000}k`;
  return String(v);
}

/** 列表里的近似简写 (131072 → 131k), 只用于展示 */
export function formatTokenShort(v: unknown): string {
  if (typeof v !== "number" || !(v > 0)) return "";
  if (v >= 1e6) {
    const m = v / 1e6;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(v);
}
