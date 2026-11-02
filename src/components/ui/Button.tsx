import type { ButtonHTMLAttributes } from "react";

// 按钮原语。全站按钮只从这里出: 尺寸两档、变体四种, 字号与圆角固定, 不再散写样式串。
// sm = 行内紧凑 (28px, label 12) · md = 常规 (32px, body 13)

const BTN_BASE =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md transition duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-40";

const BTN_SIZE = {
  sm: "h-7 px-3 text-label",
  md: "h-8 px-4 text-body",
  icon: "h-8 w-8 text-body",
  "icon-sm": "h-7 w-7 text-label",
} as const;

const BTN_VARIANT = {
  // 次级操作: 卡片底 + 细边 + 小阴影 (与卡片同一语言)
  ghost:
    "border border-line bg-card text-fg-2 shadow-sm hover:border-line-2 hover:text-fg",
  // 主操作: 墨色实底 (日间黑 / 夜间白)
  primary: "bg-accent font-medium text-on-accent shadow-sm hover:opacity-90",
  // 危险操作: 卡片底 + 红字, 悬停转红边
  danger:
    "border border-line bg-card text-err shadow-sm hover:border-err hover:bg-[color-mix(in_srgb,var(--err)_8%,var(--card))]",
  // 纯文字按钮: 工具栏 / 卡片头里的轻操作
  subtle: "text-fg-3 hover:bg-hover hover:text-fg",
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
