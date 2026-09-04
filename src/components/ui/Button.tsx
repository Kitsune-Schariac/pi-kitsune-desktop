import type { ButtonHTMLAttributes } from "react";

// 按钮原语 (token 驱动, 样式值源出 ModelsPanel 的 BTN_* 常量)。
// 主题色/边框/悬浮全部走 CSS 变量, 随 8 套皮肤自动切换, 不引组件库。
// 间距严格走 4px 整档网格 (半档 class 如 py-1.5 不会生成规则, 见 journal 踩坑)。

const BTN_BASE =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 rounded-md transition duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-40";

// 尺寸档: sm = 行内紧凑 (h-7 = 28px), md = 常规控件 (h-8 = 32px)
const BTN_SIZE = {
  sm: "h-7 px-2 text-xs",
  md: "h-8 px-3 text-xs",
} as const;

const BTN_VARIANT = {
  // 次级操作: 描边 + 悬停显边框, 无实底 —— 卡片上最安静的按钮档
  ghost:
    "border border-[var(--border-subtle)] text-neutral-600 hover:border-[var(--border-strong)] hover:bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] hover:text-neutral-800",
  // 主操作: 品牌色实底, 白字; 悬停加深一档
  primary:
    "bg-[var(--primary-500)] font-medium text-white hover:bg-[var(--primary-600)]",
  // 危险操作 (删除类): 描边 + 红字, 悬停转红边红底
  danger:
    "border border-[var(--border-subtle)] text-red-500 hover:border-red-500 hover:bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)]",
} as const;

export type ButtonVariant = keyof typeof BTN_VARIANT;
export type ButtonSize = keyof typeof BTN_SIZE;

export function Button({
  variant = "ghost",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={`${BTN_BASE} ${BTN_SIZE[size]} ${BTN_VARIANT[variant]} ${className}`}
      {...rest}
    />
  );
}
