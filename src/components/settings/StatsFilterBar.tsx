import { ReactNode } from "react";
import {
  useStatsFilterStore,
  type TimeRange,
} from "../../store/statsFilter";

// Token / 行为 两统计面板共享的筛选栏: 时间快捷 + 自定义起止 + 项目下拉
// provider/model 等面板私有筛选项经 children 插槽接入, 保证共享部分口径唯一
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

  return (
    <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* 时间快捷 */}
        <div className="flex overflow-hidden rounded-md border border-neutral-200 bg-panel text-xs">
          {(
            [
              ["today", "今天"],
              ["7d", "近 7 天"],
              ["30d", "近 30 天"],
              ["all", "全部"],
            ] as [TimeRange, string][]
          ).map(([r, label]) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-2 transition duration-fast ease-out ${
                range === r && !customStart && !customEnd
                  ? "bg-primary-500 font-medium text-white"
                  : "text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* 自定义起止 */}
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <input
            type="date"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            className="rounded-md border border-neutral-200 bg-panel px-2 py-2 text-neutral-700 outline-none focus:border-primary-400"
            title="自定义开始日期"
          />
          <span>至</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="rounded-md border border-neutral-200 bg-panel px-2 py-2 text-neutral-700 outline-none focus:border-primary-400"
            title="自定义结束日期"
          />
        </div>
      </div>
      {/* 项目 + 面板私有扩展位 */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className="max-w-[220px] rounded-md border border-neutral-200 bg-panel px-2 py-2 text-neutral-700 outline-none focus:border-primary-400"
          title="按项目筛选"
        >
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p} value={p} title={p}>
              {projectLabel(p)}
            </option>
          ))}
        </select>
        {children}
      </div>
    </div>
  );
}

// 项目路径取 basename 展示 (全路径放 title), 空路径原样
export function projectLabel(p: string) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
