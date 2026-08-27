// Token 统计 / 行为统计 共享筛选状态
// 验收口径要求两面板「切换项目/时间范围时口径相同」→ 状态唯一来源放这里,
// 各面板只保留自有筛选 (provider/model 是 token 面板私有, 不进共享)
import { create } from "zustand";

export type TimeRange = "today" | "7d" | "30d" | "all";

interface StatsFilterStore {
  range: TimeRange;
  /** 自定义起止 (YYYY-MM-DD), 非空时覆盖快捷 range */
  customStart: string;
  customEnd: string;
  /** 项目全路径, 空 = 全部 */
  project: string;
  setRange: (r: TimeRange) => void;
  setCustomStart: (v: string) => void;
  setCustomEnd: (v: string) => void;
  setProject: (p: string) => void;
}

export const useStatsFilterStore = create<StatsFilterStore>((set) => ({
  range: "30d",
  customStart: "",
  customEnd: "",
  project: "",
  // 改快捷范围时清掉自定义起止 (两者互斥, 与旧 TokenStatsPanel 行为一致)
  setRange: (range) => set({ range, customStart: "", customEnd: "" }),
  setCustomStart: (customStart) => set({ customStart }),
  setCustomEnd: (customEnd) => set({ customEnd }),
  setProject: (project) => set({ project }),
}));

/**
 * 快捷时间范围 → [start, end] 完整 ISO
 * 口径与后端天桶过滤一致: start 含当天零点, end 取次日零点 (左闭右开)
 */
export function rangeBounds(range: TimeRange): { start: string | null; end: string | null } {
  if (range === "all") return { start: null, end: null };
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = new Date(today + 86_400_000).toISOString();
  const days = range === "today" ? 0 : range === "7d" ? 6 : 29;
  return { start: new Date(today - days * 86_400_000).toISOString(), end };
}

/** 发起查询时的最终起止: 自定义优先, 否则快捷范围 */
export function resolveQueryBounds(f: {
  range: TimeRange;
  customStart: string;
  customEnd: string;
}): { startTime: string | null; endTime: string | null } {
  const rb = rangeBounds(f.range);
  return {
    startTime: f.customStart ? `${f.customStart}T00:00:00Z` : rb.start,
    endTime: f.customEnd ? `${f.customEnd}T23:59:59.999Z` : rb.end,
  };
}
