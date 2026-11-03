// 强调色推导 (纯函数, 不引 store / DOM): 一个用户选的颜色 → 日间 / 夜间各一组 accent token。
//
// 为什么不直接拿用户选的颜色当 --accent: 同一个色值在白底和黑底上的可读性天差地别 ——
// 品牌橙 #ff7400 在白底上对比度只有 2.7, 绛紫 #801aaf 在黑底上只有 2.7, 当文字 / 图标都发虚。
// 所以在 OKLCH 里保持色相与彩度, 只沿明度推到对比度达标为止 (超出 sRGB 色域时降彩度),
// 颜色「还是那个颜色」, 只是在白底上深一点、黑底上亮一点。
//
// 产出四个 token, 与 index.css 里墨色方案的同名 token 一一对应 (组件只认 token, 不认色值):
//   --accent       填充与图标: 发送钮 / 开关 / 复选框 / 运行点 / 选中条 (对底色 ≥ 3:1, 非文字元件的门槛)
//   --accent-2     文字用: 链接 / 提交哈希 / 次级标签 (对底色 ≥ 4.5:1, 正文文字的门槛)
//   --accent-soft  选中行 / 高亮行 / 焦点光晕的浅底
//   --on-accent    压在 --accent 填充上的字与图标 (白 / 黑二选一, 取对比度够的那个)

export type Base = "light" | "dark";

export interface AccentTokens {
  accent: string;
  accent2: string;
  soft: string;
  onAccent: string;
}

/** 预设: 墨 = 原来的黑白方案 (不注入任何 token); 狐橙 / 绛紫取自 logo 渐变的两端 */
export const ACCENT_PRESETS: { id: string; name: string; hex: string | null }[] = [
  { id: "fox", name: "狐橙", hex: "#ff7400" },
  { id: "rose", name: "玫红", hex: "#e5317a" },
  { id: "violet", name: "绛紫", hex: "#801aaf" },
  { id: "indigo", name: "靛蓝", hex: "#5e5ce6" },
  { id: "blue", name: "湛蓝", hex: "#0a84ff" },
  { id: "teal", name: "青碧", hex: "#0e9f9a" },
  { id: "mono", name: "墨", hex: null },
];

export const DEFAULT_ACCENT = "fox";

const HEX_RE = /^#?([0-9a-f]{6})$/i;

/** 规范化为 #rrggbb 小写; 非法输入返回 null (支持省略 #) */
export function normalizeHex(input: string): string | null {
  const m = HEX_RE.exec(input.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** 选择值 (预设 id 或 #rrggbb) → 实际色值; 墨 → null; 无法识别 → 默认预设 */
export function accentHex(choice: string): string | null {
  const preset = ACCENT_PRESETS.find((p) => p.id === choice);
  if (preset) return preset.hex;
  return normalizeHex(choice) ?? ACCENT_PRESETS.find((p) => p.id === DEFAULT_ACCENT)!.hex;
}

// ---------------------------------------------------------------------------
// 色彩空间: sRGB ⇄ 线性 RGB ⇄ OKLab ⇄ OKLCH (Björn Ottosson 的标准系数)
// ---------------------------------------------------------------------------

type RGB = [number, number, number]; // 0..1, 可能越界 (色域外)
type LCH = [number, number, number]; // L 0..1, C ≥ 0, H 度

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb: RGB): string {
  return (
    "#" +
    rgb
      .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function rgbToOklch([r, g, b]: RGB): LCH {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  const H = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return [L, C, H];
}

function oklchToRgb([L, C, H]: LCH): RGB {
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const inGamut = (rgb: RGB) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** 保持 L / H, 二分降彩度直到落进 sRGB 色域 (比直接截断通道更不偏色) */
function toGamutRgb([L, C, H]: LCH): RGB {
  let rgb = oklchToRgb([L, C, H]);
  if (inGamut(rgb)) return rgb;
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToRgb([L, mid, H]))) lo = mid;
    else hi = mid;
  }
  rgb = oklchToRgb([L, lo, H]);
  return rgb;
}

// ---------------------------------------------------------------------------
// 对比度 (WCAG 2.x 相对亮度)
// ---------------------------------------------------------------------------

function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map((c) => toLinear(Math.min(1, Math.max(0, c))));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 两套底色: 与 index.css 的 --bg 同值 (accent 只会落在 bg / card 这类最亮 / 最暗的面上) */
const BG: Record<Base, RGB> = { light: [1, 1, 1], dark: [0, 0, 0] };
const WHITE: RGB = [1, 1, 1];
const INK: RGB = hexToRgb("#111111");

/** 按最终落地的 8 位色值算对比度: 二分卡在门槛边上时, 取整能把 4.50 抹成 4.49 */
const contrastAsShown = (lch: LCH, bg: RGB) => contrast(hexToRgb(rgbToHex(toGamutRgb(lch))), bg);

/**
 * 沿明度把颜色推到「对底色对比度 ≥ target」: 日间往暗推, 夜间往亮推; 已达标就原样返回。
 * 二分找最小改动量, 每一步都做色域映射 —— 所以返回的一定是能显示的颜色。
 */
function fitContrast(lch: LCH, base: Base, target: number): LCH {
  const bg = BG[base];
  if (contrastAsShown(lch, bg) >= target) return lch;
  const [, C, H] = lch;
  // 日间: L 从当前值往 0 搜; 夜间: 往 1 搜。区间端点 (纯黑 / 纯白) 一定达标
  let ok = base === "light" ? 0 : 1;
  let bad = lch[0];
  for (let i = 0; i < 24; i++) {
    const mid = (ok + bad) / 2;
    if (contrastAsShown([mid, C, H], bg) >= target) ok = mid;
    else bad = mid;
  }
  return [ok, C, H];
}

/** 一个颜色 → 指定明暗下的整组 token */
export function deriveAccent(hex: string, base: Base): AccentTokens {
  const src = rgbToOklch(hexToRgb(hex));
  // 夜间门槛略高: 黑底上低明度的饱和色 (深紫 / 深蓝) 看着发闷, 多提一点亮
  const fill = fitContrast(src, base, base === "light" ? 3 : 4);
  const text = fitContrast(fill, base, base === "light" ? 4.5 : 6);
  const fillRgb = toGamutRgb(fill);
  const textRgb = toGamutRgb(text);
  // 填充上的字: 白字对比度够 (≥ 3, 粗图标 / 中粗字的门槛) 就用白, 否则选对比更高的那个
  const onWhite = contrast(fillRgb, WHITE);
  const onAccent = onWhite >= 3 || onWhite >= contrast(fillRgb, INK) ? "#ffffff" : "#111111";
  const [r, g, b] = fillRgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  return {
    accent: rgbToHex(fillRgb),
    accent2: rgbToHex(textRgb),
    soft: `rgba(${r}, ${g}, ${b}, ${base === "light" ? 0.11 : 0.18})`,
    onAccent,
  };
}

/** 注入用的整段 CSS: 选择器与 index.css 同权重, 靠后插入覆盖墨色默认值; 墨 → 空串 (用回原值) */
export function accentCss(choice: string): string {
  const hex = accentHex(choice);
  if (!hex) return "";
  const block = (sel: string, t: AccentTokens) =>
    `${sel} {\n  --accent: ${t.accent};\n  --accent-2: ${t.accent2};\n  --accent-soft: ${t.soft};\n  --on-accent: ${t.onAccent};\n}`;
  return [
    block(':root,\n[data-base="light"]', deriveAccent(hex, "light")),
    block('[data-base="dark"]', deriveAccent(hex, "dark")),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 调色盘用的 HSV ⇄ hex (取色面板的坐标系; 与上面的推导无关)
// ---------------------------------------------------------------------------

export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return rgbToHex([f(5), f(3), f(1)]);
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
