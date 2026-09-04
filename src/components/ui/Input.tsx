import type {
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

// 输入原语 (token 驱动)。样式源出 ModelsPanel 的 FIELD_BASE / FIELD_ON_CARD / FIELD_ON_COL。
// 两类底色: "card" = 落在 raised 卡片上的凹陷输入 (sunken 底);
//          "col"  = 落在 sunken 侧栏上的输入 (base 底)。背景随所在容器语义选, 皮肤自动适配。
// 尺寸: md = 常规 (h-8), sm = 行内紧凑 (h-7)。调用方不要覆盖 py/h (同名冲突谁赢看 CSS 顺序)。

const FIELD_BASE =
  "w-full rounded-md border text-xs text-neutral-800 outline-none transition duration-fast ease-out placeholder:text-neutral-500 focus:border-[var(--primary-400)]";

// 尺寸档: md = 常规 (32px), sm = 行内紧凑 (28px)。py 由尺寸档控制,
// 调用方不再覆盖 py (同名 class 冲突时谁赢由 CSS 顺序定, 不靠 className 拼接顺序)
const FIELD_SIZE = {
  md: "h-8 px-2 py-2",
  sm: "h-7 px-2 py-0",
} as const;

export type FieldSize = keyof typeof FIELD_SIZE;

const FIELD_BG = {
  // 卡片上的输入: 比卡片底凹陷一档
  card: "border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)]",
  // 侧栏 (sunken 底) 上的输入: 反用 base 底, 视觉上浮起
  col: "border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-base)_calc(var(--overlay-alpha)_*_100%),transparent)]",
} as const;

export type FieldSurface = keyof typeof FIELD_BG;

/** 字段标签; hint 是弱化说明 (比正文再弱一档) */
export function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
      {children}
      {hint && <span className="text-xs text-neutral-400">{hint}</span>}
    </span>
  );
}

export function Input({
  surface = "card",
  density = "md",
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  surface?: FieldSurface;
  /** 控件密度 (避开原生 input 的 size 属性名): md = 常规, sm = 行内紧凑 */
  density?: FieldSize;
}) {
  return (
    <input
      className={`${FIELD_BASE} ${FIELD_SIZE[density]} ${FIELD_BG[surface]} ${className}`}
      {...rest}
    />
  );
}

export function Textarea({
  surface = "card",
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { surface?: FieldSurface }) {
  return (
    <textarea
      className={`${FIELD_BASE} min-h-[88px] resize-y py-2 ${FIELD_BG[surface]} ${className}`}
      {...rest}
    />
  );
}
