import type { CSSProperties, ReactNode } from "react";
import { Check } from "lucide-react";

// 开关 / 复选框 / 滑杆: 取代散落各处的原生 checkbox 与 range。
// 颜色只用墨色 (日间黑 / 夜间白) 与灰阶, 尺寸固定。

/** 开关: 设置项的布尔值一律用它 (立即生效的开关语义) */
export function Switch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-base ease-out disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-line-2"
      } ${className}`}
    >
      <span
        className={`absolute left-[2px] h-4 w-4 rounded-full shadow-sm transition-transform duration-base ease-swift ${
          checked ? "translate-x-4 bg-on-accent" : "translate-x-0 bg-[var(--switch-thumb,#fff)]"
        }`}
      />
    </button>
  );
}

/** 复选框: 列表里的多选 / 表单里的勾选项 (需要和一段文字同行时用 label 包起来) */
export function Checkbox({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  children,
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** 跟在框后的文字 (可点) */
  children?: ReactNode;
  className?: string;
}) {
  const box = (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border transition duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "border-accent bg-accent text-on-accent" : "border-line-2 bg-card hover:border-fg-4"
      } ${children ? "" : className}`}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  );
  if (!children) return box;
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 text-body text-fg-2 ${disabled ? "cursor-not-allowed opacity-60" : ""} ${className}`}
    >
      {box}
      <span
        onClick={(e) => {
          // label 里的 button 不会被 label 自动代理点击, 手动转发
          e.preventDefault();
          if (!disabled) onChange(!checked);
        }}
      >
        {children}
      </span>
    </label>
  );
}

/** 滑杆: 已填充段用墨色, 未填充段用线色; 右侧可选显示当前值 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled = false,
  format,
  ariaLabel,
  className = "",
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** 给了就在右侧显示数值 */
  format?: (value: number) => string;
  ariaLabel?: string;
  className?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--fill": `${pct}%` } as CSSProperties}
        className="min-w-0 flex-1"
      />
      {format && (
        <span className="w-10 shrink-0 text-right text-body tabular-nums text-fg">{format(value)}</span>
      )}
    </div>
  );
}
