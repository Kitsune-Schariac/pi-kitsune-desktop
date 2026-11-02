import type { ReactNode } from "react";

// 分段控件: 浅填充轨道 + 选中项浮起成小卡片 (卡片底 + 小阴影)。
// 全站「几个互斥视图 / 取值之间切换」只用它: 会话列表的最近/项目、检查器页签、统计时间范围、
// 外观模式、接口类型、思考档位……不再有下划线页签与各自手写的按钮组。
// 受控组件: value 为 null 表示当前没有选中项。

const SEG_SIZE = {
  sm: "h-6 px-2 text-label",
  md: "h-7 px-3 text-body",
} as const;

export type SegmentedSize = keyof typeof SEG_SIZE;

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  accent: _accent = false,
  disabled = false,
  fill = false,
  className = "",
  ariaLabel,
}: {
  value: T | null;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: SegmentedSize;
  /** 旧参数, 单色设计下选中项本来就是最高对比, 保留形参兼容调用方 */
  accent?: boolean;
  disabled?: boolean;
  /** 撑满容器宽, 各项等分 */
  fill?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      // 轨道 10 圆角 − 3 内边距 = 滑块 7 圆角 (同心); 轨道不描边, 只用浅填充
      className={`${fill ? "flex w-full" : "inline-flex"} shrink-0 gap-[2px] rounded-md bg-fg/[0.055] p-[3px] ${className}`}
    >
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            title={opt.title}
            aria-selected={on}
            disabled={disabled || opt.disabled}
            onClick={() => {
              if (!on) onChange(opt.value);
            }}
            className={`inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-[7px] transition duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-40 ${
              fill ? "min-w-0 flex-1" : ""
            } ${SEG_SIZE[size]} ${
              on
                ? "bg-card font-medium text-fg shadow-[var(--shadow-sm),inset_0_0_0_1px_var(--edge)]"
                : "text-fg-3 hover:text-fg"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
