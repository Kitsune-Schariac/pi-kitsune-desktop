import type { HTMLAttributes, ReactNode } from "react";

// 卡片家族: 全站内容分组只用这一种容器 —— 卡片底 + 细边 + 阴影, 圆角 12。
// Section = 分区标题 + 卡片; SettingRow = 卡片里的一行设置 (左说明, 右控件), 行间细线分隔。

export function Card({
  className = "",
  padded = false,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return (
    <div className={`card ${padded ? "p-4" : ""} ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** 分区: 标题行 (标题 + 可选说明 + 右侧操作) + 内容 */
export function Section({
  title,
  desc,
  action,
  children,
  className = "",
}: {
  title: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-3 flex min-h-7 items-end justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-lead font-semibold text-fg">{title}</h3>
          {desc && <p className="mt-1 text-label text-fg-3">{desc}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** 设置行: 左侧标题 + 说明, 右侧控件; 放在 Card 里, 相邻行之间自动加分隔线 */
export function SettingRow({
  title,
  desc,
  children,
  className = "",
}: {
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    // 行间分隔线内缩 16px, 不顶到卡片两侧 (顶边的直线会把圆角卡片切成方格)
    <div
      className={`relative flex min-h-14 items-center justify-between gap-6 px-4 py-3 [&+&]:before:absolute [&+&]:before:inset-x-4 [&+&]:before:top-0 [&+&]:before:h-px [&+&]:before:bg-line [&+&]:before:content-[''] ${className}`}
    >
      <div className="min-w-0">
        <div className="text-body text-fg">{title}</div>
        {desc && <div className="mt-[2px] text-label text-fg-4">{desc}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** 小徽标: 数量 / 状态 / 标签 */
export function Badge({
  children,
  tone = "neutral",
  className = "",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "err" | "warn" | "solid";
  className?: string;
  title?: string;
}) {
  const toneCls = {
    neutral: "bg-fg/[0.06] text-fg-3",
    ok: "bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] text-ok",
    err: "bg-[color-mix(in_srgb,var(--err)_12%,transparent)] text-err",
    warn: "bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] text-warn",
    solid: "bg-accent text-on-accent",
  }[tone];
  return (
    <span
      title={title}
      className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-meta ${toneCls} ${className}`}
    >
      {children}
    </span>
  );
}

/** 空态: 虚线框 + 图标 + 一两行说明 */
export function EmptyHint({
  icon,
  title,
  children,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-2 rounded-lg bg-fg/[0.03] px-6 py-10 text-center ${className}`}
    >
      {icon && <div className="text-fg-4">{icon}</div>}
      <div className="text-body text-fg-2">{title}</div>
      {children && <div className="text-label text-fg-4">{children}</div>}
    </div>
  );
}
