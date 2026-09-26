// 纯 UI 状态 store (design §3.2): 外壳的展开 / 页签 / 选中步, 与数据 store 分离。
// 持久化: paneOpen / listMode 落 localStorage; inspectorOpen 不持久化 —— 随风格初始化
// (App 在风格变化时设初值: 工坊展开, 舞台收起把右侧让给角色), selectedStepId 随会话切换清空。
import { create } from "zustand";

const PANE_OPEN_KEY = "kitsune.paneOpen";
const LEGACY_SIDEBAR_COLLAPSED_KEY = "kitsune.sidebarCollapsed";
const LIST_MODE_KEY = "kitsune.listMode";

export type InspectorTab = "detail" | "git" | "fleet" | "trellis";
export type SessionListMode = "recent" | "projects";

/** 首次读取 paneOpen: 无新键时从旧 kitsune.sidebarCollapsed 迁移 (旧键 1 = 收起), 迁完删旧键 */
function readPaneOpen(): boolean {
  const saved = localStorage.getItem(PANE_OPEN_KEY);
  if (saved !== null) return saved === "1";
  const legacy = localStorage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
  if (legacy !== null) {
    const open = legacy !== "1";
    localStorage.setItem(PANE_OPEN_KEY, open ? "1" : "0");
    localStorage.removeItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
    return open;
  }
  return true;
}

function readListMode(): SessionListMode {
  return localStorage.getItem(LIST_MODE_KEY) === "recent" ? "recent" : "projects";
}

interface UiStore {
  /** 会话列表展开 (持久化 kitsune.paneOpen) */
  paneOpen: boolean;
  /** 会话列表视图: 最近 / 项目 (持久化 kitsune.listMode) */
  listMode: SessionListMode;
  /** 检查器展开 (不持久化, 随风格初始化) */
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  /** 检查器选中的步骤条目 id (ChatEntry.id); 切会话时清空 */
  selectedStepId: string | null;
  /** 「在时间线定位」递增信号: Timeline 订阅后 scrollIntoView + 闪烁 */
  locateStepSeq: number;
  togglePane: () => void;
  setListMode: (mode: SessionListMode) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  /** 选中步骤 + 切详情页签 + 打开检查器 */
  openStep: (id: string) => void;
  clearStep: () => void;
  /** 请求时间线定位当前选中步骤 (递增信号) */
  locateStep: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  paneOpen: readPaneOpen(),
  listMode: readListMode(),
  inspectorOpen: false,
  inspectorTab: "detail",
  selectedStepId: null,
  locateStepSeq: 0,

  togglePane: () =>
    set((s) => {
      const next = !s.paneOpen;
      try {
        localStorage.setItem(PANE_OPEN_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return { paneOpen: next };
    }),

  setListMode: (mode) => {
    set({ listMode: mode });
    try {
      localStorage.setItem(LIST_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  },

  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  setInspectorTab: (tab) => set({ inspectorTab: tab }),

  openStep: (id) =>
    set({ selectedStepId: id, inspectorTab: "detail", inspectorOpen: true }),

  clearStep: () => set({ selectedStepId: null }),

  locateStep: () => set((s) => ({ locateStepSeq: s.locateStepSeq + 1 })),
}));
