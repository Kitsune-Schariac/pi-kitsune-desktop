import { ReactNode } from "react";
import { CalendarRange } from "lucide-react";
import { useStatsFilterStore, type TimeRange } from "../../store/statsFilter";
import { Card, DateInput, Segmented, Select } from "../ui";

const RANGES: { value: TimeRange; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "all", label: "全部" },
];

// Token / 行为 两统计面板共享的筛选栏 (一张工具卡): 时间快捷 + 自定义起止 + 项目;
// provider/model 等面板私有筛选项经 children 插槽接入 (传 Select 原语), 保证共享部分口径唯一
export function StatsFilterBar({
  projects,
  children,
}: {
  projects: string[];
  children?: ReactNode;
}) {
  const range = useStatsFilterStore((s) => s.range);
  const customStart = useStatsFilterStore((s) => s.customStart);
  const customEnd = useStatsFilterStore((s) => s.customEnd);
  const project = useStatsFilterStore((s) => s.project);
  const setRange = useStatsFilterStore((s) => s.setRange);
  const setCustomStart = useStatsFilterStore((s) => s.setCustomStart);
  const setCustomEnd = useStatsFilterStore((s) => s.setCustomEnd);
  const setProject = useStatsFilterStore((s) => s.setProject);
  // 填了自定义起止时快捷档不再生效, 分段控件显示为无选中
  const custom = !!(customStart || customEnd);

  return (
    <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Segmented
        value={custom ? null : range}
        options={RANGES}
        onChange={setRange}
        ariaLabel="时间范围"
      />
      <div className="flex items-center gap-2 text-label text-fg-4">
        <CalendarRange className="h-4 w-4 shrink-0" />
        <DateInput value={customStart} onChange={setCustomStart} title="自定义开始日期" />
        <span>至</span>
        <DateInput value={customEnd} onChange={setCustomEnd} title="自定义结束日期" />
      </div>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <Select
        value={project}
        onChange={setProject}
        title="按项目筛选"
        className="w-[180px]"
        options={[
          { value: "", label: "全部项目" },
          ...projects.map((p) => ({ value: p, label: projectLabel(p), title: p })),
        ]}
      />
      {children}
    </Card>
  );
}

// 项目路径取 basename 展示 (全路径放 title), 空路径原样
export function projectLabel(p: string) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
