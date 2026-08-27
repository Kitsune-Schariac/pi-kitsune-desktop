// Subagent 舰队面板状态 store: 扫描 pi-subagents 产物目录的 run 列表 + 懒加载详情。
// 与 session/git store 同模式: 按需 invoke, selector 订阅, 不在组件里直接 listen。
// 轮询策略 (design §3): 2s 轮询 status.json, 面板开着才轮询 (引用计数), 关闭即停;
// invoke 失败只置 lastError 静默降级, 不弹错误 (PRD R4: 用户没装/没用 subagent 是正常状态)。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { StreamEntry } from "../lib/fleetStream";

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
  // 主会话 uuid (从 status.json sessionId 路径解析, 会话锚定用, 空串=无法归属)
  session_id: string;
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
  // 视图范围: 本会话 / 全部, 默认本会话 (会话锚定, design §3)
  scope: "current" | "all";
  setScope: (scope: "current" | "all") => void;
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
  scope: "current",
  setScope: (scope) => set({ scope }),

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

// --- 双源统一视图模型 (design §1) + 会话锚定辅助 (design §3) ---

export type FleetSource = "artifact" | "stream";

export interface FleetEntry {
  key: string; // 唯一: `artifact:<run_id>` / `stream:<tool_call_id>`
  source: FleetSource;
  agent: string;
  state: "running" | "completed" | "failed" | "unknown";
  startedAt: number;
  endedAt?: number;
  durationMs?: number; // running 时 = now - startedAt (面板 tick 驱动); completed 用 endedAt - startedAt
  isCurrentSession: boolean; // artifact: session_id 匹配; stream: 恒 true
  // artifact 独有: v1 run 摘要整体引用 (详情/子会话下钻复用, 不动 v1 链路)
  run?: FleetRunSummary;
  // stream 独有: 推导出的前台子代理条目 (含 prompt/resultSummary/full*)
  call?: StreamEntry;
}

// 终态字符串 → FleetEntry.state (artifact run.state 是 stringly-typed, 宽松映射, 与 Rust TERMINAL_STATES 对齐)
const ARTIFACT_TERMINAL = new Set([
  "complete", "completed", "success", "succeeded", "done", "finished",
  "cancelled", "canceled", "stopped", // 与 Rust TERMINAL_STATES 对齐 (review SF1)
]);
const ARTIFACT_FAILED = new Set(["failed", "error", "aborted"]);

// 从主会话 jsonl 文件路径解析出 uuid (与 Rust parse_session_uuid 对称)。
// 文件名 `<ts>_<uuid>.jsonl`, 取最后 `_` 后段去 `.jsonl`。缺失/畸形 → 空串 (宁漏勿误)
export function parseSessionUuid(path: string | null | undefined): string {
  if (!path) return "";
  const stem = path.split(/[\\/]/).pop() ?? path;
  const idx = stem.lastIndexOf("_");
  if (idx < 0) return "";
  const after = stem.slice(idx + 1);
  return after.endsWith(".jsonl") ? after.slice(0, -6) : "";
}

// artifact run → FleetEntry (会话锚定: isCurrentSession 由面板用 parseSessionUuid 比对后传入)
export function toArtifactEntry(
  run: FleetRunSummary,
  isCurrentSession: boolean,
): FleetEntry {
  const state: FleetEntry["state"] = run.active
    ? "running"
    : ARTIFACT_FAILED.has(run.state)
      ? "failed"
      : ARTIFACT_TERMINAL.has(run.state)
        ? "completed"
        : "unknown";
  // agent 取末步 (最近活动的子 agent), 缺失用 runId 前 8 位
  const lastStep = run.steps[run.steps.length - 1];
  return {
    key: `artifact:${run.run_id}`,
    source: "artifact",
    agent: lastStep?.agent || run.run_id.slice(0, 8),
    state,
    startedAt: run.started_at,
    endedAt: run.ended_at || undefined,
    durationMs: run.duration_ms || undefined,
    isCurrentSession,
    run,
  };
}

// stream 条目 → FleetEntry (isCurrentSession 恒 true; durationMs 由面板 now tick 驱动)
export function toStreamEntry(s: StreamEntry, now: number): FleetEntry {
  const durationMs =
    s.state === "running"
      ? s.startedAt
        ? Math.max(0, now - s.startedAt)
        : undefined
      : s.startedAt && s.endedAt
        ? s.endedAt - s.startedAt
        : undefined;
  return {
    key: s.key,
    source: "stream",
    agent: s.agent,
    state: s.state,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationMs,
    isCurrentSession: true,
    call: s,
  };
}
