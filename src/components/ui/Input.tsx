import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";

// 输入原语 (token 驱动)。样式源出 ModelsPanel 的 FIELD_BASE / FIELD_ON_CARD / FIELD_ON_COL。
// surface 形参保留兼容旧调用方 (card/col); 新语义下两种容器都落凹陷井 (--well) + 常规分隔线 (--line)。
// 尺寸: md = 常规 (h-8), sm = 行内紧凑 (h-7)。调用方不要覆盖 py/h (同名冲突谁赢看 CSS 顺序)。

const FIELD_BASE =
  "w-full rounded-md border text-xs text-[var(--fg)] outline-none transition duration-fast ease-out placeholder:text-[var(--fg-4)] focus:border-[var(--accent)]";

// 尺寸档: md = 常规 (32px), sm = 行内紧凑 (28px)。py 由尺寸档控制,
// 调用方不再覆盖 py (同名 class 冲突时谁赢由 CSS 顺序定, 不靠 className 拼接顺序)
const FIELD_SIZE = {
  md: "h-8 px-2 py-2",
  sm: "h-7 px-2 py-0",
} as const;

export type FieldSize = keyof typeof FIELD_SIZE;

const FIELD_BG = {
  // 卡片上的输入: 比卡片底凹陷一档
  card: "border-[var(--line)] bg-[var(--well)]",
  // 侧栏上的输入: 新语义下同样落凹陷井 (旧 base 底通道废弃, 保留形参兼容调用方)
  col: "border-[var(--line)] bg-[var(--well)]",
} as const;

export type FieldSurface = keyof typeof FIELD_BG;

/** 字段标签; hint 是弱化说明 (比正文再弱一档) */
export function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="mb-1 flex items-center gap-2 text-xs text-[var(--fg-3)]">
      {children}
      {hint && <span className="text-xs text-[var(--fg-4)]">{hint}</span>}
    </span>
  );
}

export function Input({
  surface = "card",
  density = "md",
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  /** React 19 起 ref 是普通 prop, 随 rest 透传到 input (需要程序化聚焦的调用方用) */
  ref?: Ref<HTMLInputElement>;
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
