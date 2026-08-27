// Trellis 任务视图 store: 快照拉取 (活动 + 归档任务 + current 指针), 与 pi 完全解耦。
// 不轮询 (design 关键决策): 任务状态变化频率极低且无机器事件源, 打开面板拉一次 +
// 手动刷新 + 切 cwd 重拉即可。快照同时服务于 App 药丸显隐探测 (exists) 与面板列表。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// 异步槽位防串台守卫 (spec 统一模式): 快速切项目时, 旧 cwd 的迟到快照不得覆盖新 cwd 视图。
// 每次发起新 load 递增, 迟到结果与当前值不符即丢弃。
let loadEpoch = 0;

// Rust 侧 (trellis_tasks.rs) 字段 snake_case 原样透传, 前端类型对齐 created_at 等下划线字段。
// Trellis 上游 schema 可能增删字段 (PRD 待解决未知), Rust 已宽松解析兜底, 这里只收已约定的字段。
export interface TrellisTaskSummary {
  dir: string; // 任务目录名, 树 key + 读产物入参
  id: string;
  title: string;
  description: string;
  status: string; // planning | in_progress | completed | ...未知透传
  priority: string; // P1 | P2 | ...
  assignee: string;
  parent: string;
  children: string[];
  created_at: string;
  completed_at: string;
  has_prd: boolean;
  has_design: boolean;
  has_implement: boolean;
  is_archived: boolean;
}

export interface TrellisTasksSnapshot {
  exists: boolean;
  tasks: TrellisTaskSummary[];
  current_task_ref: string | null;
}

interface TrellisTasksStore {
  tasks: TrellisTaskSummary[];
  // cwd 的 .trellis/tasks/ 是否存在: false → App 药丸不显示 (R3 安静降级)
  exists: boolean;
  // 恰好 1 个 session 文件时的 current_task 引用; 多窗口 (0/≥2) → null, 不标当前任务
  currentTaskRef: string | null;
  loading: boolean;
  lastError: string | null;
  load: (cwd: string) => Promise<void>;
}

export const useTrellisTasksStore = create<TrellisTasksStore>((set) => ({
  tasks: [],
  exists: false,
  currentTaskRef: null,
  loading: false,
  lastError: null,

  load: async (cwd) => {
    const epoch = ++loadEpoch;
    set({ loading: true, lastError: null });
    try {
      const snap = await invoke<TrellisTasksSnapshot>("list_trellis_tasks", { cwd });
      if (epoch !== loadEpoch) return;
      set({
        tasks: snap.tasks,
        exists: snap.exists,
        currentTaskRef: snap.current_task_ref,
        loading: false,
        lastError: null,
      });
    } catch (e) {
      if (epoch !== loadEpoch) return;
      // 快照读取失败: 降级为无 Trellis (药丸隐藏, R3), lastError 供面板红条展示
      set({ tasks: [], exists: false, currentTaskRef: null, loading: false, lastError: String(e) });
    }
  },
}));

/**
 * current_task_ref 宽容归一比对 (design §1): Trellis 的 task_ref 允许短名/路径/带日期前缀,
 * GUI 用「task 目录名后缀匹配」宽容比对 —— 取 ref 末段文件名, 与目录名精确相等或作为其
 * 后缀命中 (如 ref 短名 `trellis-task-view` 匹配目录 `08-25-trellis-task-view`)。
 * 最短 4 字符防御: 避免极短 ref 误命中一堆同名尾缀目录。
 */
export function isCurrentTask(taskDir: string, currentTaskRef: string | null): boolean {
  if (!currentTaskRef) return false;
  const refName = currentTaskRef.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (refName.length < 4) return false;
  return taskDir === refName || taskDir.endsWith(refName);
}

/**
 * 父引用宽容解析 (design §1 同款): parent 可能是目录名/短名/路径, 取末段后在任务集内
 * 精确匹配, 未命中再按后缀匹配兜底。解析不到 (父被归档/删除/引用笔误) → null,
 * 该任务按树根处理, 不塌陷丢失。
 */
export function resolveParentRef(
  parent: string,
  selfDir: string,
  byDir: Map<string, TrellisTaskSummary>,
  tasks: TrellisTaskSummary[],
): TrellisTaskSummary | null {
  if (!parent) return null;
  const refName = parent.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (!refName) return null;
  const exact = byDir.get(refName);
  if (exact && exact.dir !== selfDir) return exact;
  for (const t of tasks) {
    if (t.dir !== selfDir && t.dir.endsWith(refName)) return t;
  }
  return null;
}