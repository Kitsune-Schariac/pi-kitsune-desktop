import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";

// 输入原语: 凹陷井底 + 细边, 聚焦时边框加深并外扩一圈淡环 (全站输入框同一手感)。
// 尺寸: md = 常规 (32px), sm = 行内紧凑 (28px)。调用方不要覆盖 h/py。

export const FIELD_BASE =
  "w-full rounded-md border border-line bg-well text-body text-fg outline-none transition duration-fast ease-out placeholder:text-fg-4 hover:border-line-2 focus:border-fg-3 focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50";

const FIELD_SIZE = {
  md: "h-8 px-3",
  sm: "h-7 px-2 text-label",
} as const;

export type FieldSize = keyof typeof FIELD_SIZE;

/** surface 形参为旧调用方保留 (card / col), 两种容器上的输入框外观已统一 */
export type FieldSurface = "card" | "col";

/** 字段标签; hint 是弱化说明 */
export function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="mb-1 flex items-center gap-2 text-label text-fg-3">
      {children}
      {hint && <span className="text-meta text-fg-4">{hint}</span>}
    </span>
  );
}

export function Input({
  surface: _surface,
  density = "md",
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  /** React 19 起 ref 是普通 prop, 随 rest 透传到 input */
  ref?: Ref<HTMLInputElement>;
  surface?: FieldSurface;
  /** 控件密度 (避开原生 input 的 size 属性名) */
  density?: FieldSize;
}) {
  return <input className={`${FIELD_BASE} ${FIELD_SIZE[density]} ${className}`} {...rest} />;
}

export function Textarea({
  surface: _surface,
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { surface?: FieldSurface }) {
  return (
    <textarea
      className={`${FIELD_BASE} min-h-[88px] resize-y px-3 py-2 leading-relaxed ${className}`}
      {...rest}
    />
  );
}

/** 日期框: 与 Input 同外观, 原生日历弹层随明暗切换 (color-scheme 由根节点给) */
export function DateInput({
  value,
  onChange,
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "value"> & {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${FIELD_BASE} h-8 !w-[148px] shrink-0 px-3 tabular-nums ${value ? "" : "text-fg-4"} ${className}`}
      {...rest}
    />
  );
}
