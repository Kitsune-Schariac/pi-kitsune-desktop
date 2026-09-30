import type { ReactNode } from "react";

// 分段控件原语: 凹陷井底 + 选中项浮起 (raise 底 + 细阴影)。用于三五个互斥取值的就地切换
// (接口类型 / 自动·开·关 / 思考档位), 比下拉少一次点击且取值一眼可见。
// 受控组件: value 为 null 表示当前没有选中项 (如配置里的值不在选项内)。

const SEG_SIZE = {
  sm: "h-[22px] px-2 text-mini",
  md: "h-[26px] px-3 text-label",
} as const;

export type SegmentedSize = keyof typeof SEG_SIZE;

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  accent = false,
  disabled = false,
  className = "",
  ariaLabel,
}: {
  value: T | null;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: SegmentedSize;
  /** 选中项文字用强调色 (如默认思考档位这类「当前生效值」) */
  accent?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`inline-flex shrink-0 gap-[2px] rounded-md border border-[var(--line)] bg-[var(--well)] p-[2px] ${className}`}
    >
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => {
              if (!on) onChange(opt.value);
            }}
            className={`inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-[6px] transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-40 ${SEG_SIZE[size]} ${
              on
                ? `bg-[var(--raise)] shadow-[var(--shadow-sm),inset_0_0_0_1px_var(--line)] ${accent ? "text-[var(--accent)]" : "text-[var(--fg)]"}`
                : "text-[var(--fg-3)] hover:text-[var(--fg)]"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
