// Subagent 舰队面板状态 store: 扫描 pi-subagents 产物目录的 run 列表 + 懒加载详情。
// 与 session/git store 同模式: 按需 invoke, selector 订阅, 不在组件里直接 listen。
// 轮询策略 (design §3): 2s 轮询 status.json, 面板开着才轮询 (引用计数), 关闭即停;
// invoke 失败只置 lastError 静默降级, 不弹错误 (PRD R4: 用户没装/没用 subagent 是正常状态)。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// Rust 侧 (subagent_fleet.rs) 结构体无 serde rename_all, 字段 snake_case 原样透传
// (与 session_fs / git 前端约定一致)。前端类型必须对齐下划线字段, 否则拿到 undefined。
export interface FleetStepSummary {
  agent: string;
  status: string;
  model: string;
  session_file: string; // 下钻子会话权威路径 (缺失则该 step 不可下钻)
  duration_ms: number;
  tokens: number;
  error: string;
  recent_output: string[]; // 末 5 行文本
  children: FleetStepSummary[]; // 子 agent 再 fanout 嵌套 (R2 递归渲染, 通常空)
}

export interface FleetRunSummary {
  run_id: string;
  dir: string; // run 目录绝对路径, 传回 read_fleet_run_detail 用
  mode: string;
  state: string;
  started_at: number; // epoch ms
  last_update: number;
  ended_at: number; // ==0 表示未结束
  duration_ms: number;
  cwd: string;
  total_tokens: number;
  total_cost_usd: number;
  turn_count: number;
  tool_count: number;
  error: string;
  current_step: number;
  active: boolean;
  steps: FleetStepSummary[];
  session_file: string; // 顶层 sessionFile (step 缺失时下钻兜底)
}

export interface FleetRunDetail {
  status: Record<string, unknown>; // status.json 原始对象, 前端自行取需要的字段
  events: Record<string, unknown>[]; // events.jsonl 尾部 50 条
}

interface FleetStore {
  runs: FleetRunSummary[];
  loading: boolean;
  lastError: string | null; // invoke 失败时的产物目录不可达提示 (面板内小字, 不弹错)
  detail: FleetRunDetail | null;
  detailDir: string | null; // 当前详情对应的 run 目录 (防串台校验)
  detailLoading: boolean;
  detailError: string | null;
  // ToolCallCard 联动按钮触发: 递增计数器, App 订阅后开舰队面板 (与 Git 面板互斥)
  panelRequest: number;
  startPolling: () => void;
  stopPolling: () => void;
  refresh: () => Promise<void>;
  openRunDetail: (dir: string) => Promise<void>;
  closeRunDetail: () => void;
  requestOpenPanel: () => void;
}

// 轮询引用计数: 多组件挂载都 start 时计数累加, 卸载 stop 递减, 归零才真正停轮询。
// 防止面板内子视图切换时重复启停定时器, 保证「面板开着才轮询, 关闭即停」零常驻成本。
let pollRefCount = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// 详情防串台守卫: 快速连点 run A→B 时, A 迟到的 resolve 不得覆盖 B 视图 (同 git.ts 模式)
let detailEpoch = 0;

export const useFleetStore = create<FleetStore>((set, get) => ({
  runs: [],
  loading: false,
  lastError: null,
  detail: null,
  detailDir: null,
  detailLoading: false,
  detailError: null,
  panelRequest: 0,

  startPolling: () => {
    pollRefCount++;
    // 首个订阅者立即拉一次 (面板刚开就有数据, 不干等 2s), 再起定时器
    if (pollRefCount === 1 && !pollTimer) {
      void get().refresh();
      pollTimer = setInterval(() => void get().refresh(), 2000);
    }
  },

  stopPolling: () => {
    pollRefCount = Math.max(0, pollRefCount - 1);
    if (pollRefCount === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const snap = await invoke<{ runs: FleetRunSummary[] }>("list_fleet_runs");
      set({ runs: snap.runs ?? [], lastError: null });
    } catch (e) {
      // 产物目录不可达 / invoke 失败: 安静降级, 只置 lastError 供面板内小字提示, 不弹错 (PRD R4)
      set({ lastError: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  openRunDetail: async (dir) => {
    const epoch = ++detailEpoch;
    set({ detailLoading: true, detailError: null });
    try {
      const detail = await invoke<FleetRunDetail>("read_fleet_run_detail", { runDir: dir });
      if (epoch !== detailEpoch) return; // 已有更新请求介入, 过期结果丢弃
      set({ detail, detailDir: dir, detailLoading: false, detailError: null });
    } catch (e) {
      if (epoch !== detailEpoch) return;
      set({ detailError: String(e), detailLoading: false });
    }
  },

  closeRunDetail: () => {
    detailEpoch++; // 清除与新请求同等递增, 防 in-flight 旧结果回填已关闭的槽位
    set({ detail: null, detailDir: null, detailLoading: false, detailError: null });
  },

  // ToolCallCard 「在舰队中查看」按钮调: 递增计数器, App effect 订阅后开面板 + 关 Git
  requestOpenPanel: () => set((s) => ({ panelRequest: s.panelRequest + 1 })),
}));