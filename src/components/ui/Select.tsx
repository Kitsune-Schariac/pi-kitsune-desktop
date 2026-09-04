import type { ReactNode, SelectHTMLAttributes } from "react";

// 下拉原语 (token 驱动, 原生 select 元素)。
// 只收敛样式与外观一致, 交互仍是浏览器原生 (弹出层/键盘导航由 UA 保证),
// 不做自定义弹层 —— 那是外部组件库的活, 手搓弹层成本远大于收益。
// 宽度默认随内容 (原生 select 收起 = 选中项文字宽), 需要最小宽/定宽用 className 补。
// density: md = 常规 (h-8), sm = 行内紧凑 (h-7)。调用方不要覆盖 h (同名冲突谁赢看 CSS 顺序)。

const SELECT_BASE =
  "shrink-0 cursor-pointer appearance-none rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] bg-[length:12px] bg-[right_8px_center] bg-no-repeat px-2 pr-7 text-xs text-neutral-700 outline-none transition duration-fast ease-out hover:border-[var(--border-strong)] focus:border-[var(--primary-400)] disabled:cursor-not-allowed disabled:opacity-40";

const SELECT_DENSITY = {
  md: "h-8",
  sm: "h-7",
} as const;

export type SelectDensity = keyof typeof SELECT_DENSITY;

// 自定义下拉箭头 (原生 appearance-none 后没有箭头; 用内联 SVG 背景图)
const ARROW_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;

export function Select({
  density = "md",
  className = "",
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  children?: ReactNode;
  density?: SelectDensity;
}) {
  return (
    <select
      style={{ backgroundImage: ARROW_SVG }}
      className={`${SELECT_BASE} ${SELECT_DENSITY[density]} ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
