// M4: 侧边栏项目/会话数据 store
// 数据源: Rust list_projects_and_sessions (扫描 ~/.pi/agent/sessions/)
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface SessionNode {
  file_name: string;
  session_path: string;
  timestamp: string;
  session_id: string;
  preview: string;
}

export interface ProjectNode {
  path: string;
  display_name: string;
  expanded: boolean;
  visibleCount: number; // 已展开的会话数 (最近 5 + 每次 +7)
  removed: boolean; // 本地移除 (不删 pi 数据)
  sessions: SessionNode[];
}

interface ProjectsStore {
  projects: ProjectNode[];
  loaded: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  toggleProject: (path: string) => void;
  loadMore: (path: string) => void;
  removeProject: (path: string) => void;
  removeSession: (projectPath: string, sessionPath: string) => Promise<void>;
  moveProject: (fromIndex: number, toIndex: number) => void;
}

const ORDER_KEY = "kitsune.projectOrder";
const EXPAND_KEY = "kitsune.projectExpanded";

// 项目顺序持久化: localStorage 存顺序路径数组
function loadOrder(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export const useProjectsStore = create<ProjectsStore>((set) => ({
  projects: [],
  loaded: false,
  error: null,

  loadProjects: async () => {
    try {
      const list = await invoke<ProjectNode[]>("list_projects_and_sessions");
      const order = loadOrder();
      // 展开状态持久化
      let expanded: string[] = [];
      try {
        expanded = JSON.parse(localStorage.getItem(EXPAND_KEY) ?? "[]") as string[];
      } catch { /* ignore */ }
      const orderIndex = new Map(order.map((p, i) => [p, i]));
      // 按持久化顺序排 (未记录的排最后), 已移除的项目不再显示
      list.sort((a, b) => {
        const ia = orderIndex.has(a.path) ? orderIndex.get(a.path)! : order.length;
        const ib = orderIndex.has(b.path) ? orderIndex.get(b.path)! : order.length;
        return ia - ib;
      });
      const projects = list
        .filter((p) => !expanded.includes(`removed:${p.path}`))
        .map((p) => ({
          ...p,
          expanded: expanded.includes(p.path),
          visibleCount: 5,
          removed: false,
        }));
      set({ projects, loaded: true, error: null });
    } catch (e) {
      set({ error: String(e), loaded: true });
    }
  },

  toggleProject: (path) => {
    set((state) => {
      const projects = state.projects.map((p) =>
        p.path === path ? { ...p, expanded: !p.expanded } : p
      );
      // 展开状态持久化
      const expanded = projects.filter((p) => p.expanded).map((p) => p.path);
      try { localStorage.setItem(EXPAND_KEY, JSON.stringify(expanded)); } catch { /* ignore */ }
      return { projects };
    });
  },

  loadMore: (path) => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.path === path ? { ...p, visibleCount: p.visibleCount + 7 } : p
      ),
    }));
  },

  removeProject: (path) => {
    set((state) => {
      const projects = state.projects.filter((p) => p.path !== path);
      // 记录已移除 (防止下次 loadProjects 重新出现), 不删 pi 数据
      let removed: string[] = [];
      try {
        removed = JSON.parse(localStorage.getItem(EXPAND_KEY) ?? "[]") as string[];
      } catch { /* ignore */ }
      removed.push(`removed:${path}`);
      try { localStorage.setItem(EXPAND_KEY, JSON.stringify(removed)); } catch { /* ignore */ }
      return { projects };
    });
  },

  removeSession: async (projectPath, sessionPath) => {
    try {
      await invoke("delete_session_file", { sessionPath });
    } catch (e) {
      set({ error: String(e) });
      return;
    }
    set((state) => ({
      projects: state.projects.map((p) =>
        p.path === projectPath
          ? { ...p, sessions: p.sessions.filter((s) => s.session_path !== sessionPath) }
          : p
      ),
    }));
  },

  moveProject: (fromIndex, toIndex) => {
    set((state) => {
      const projects = [...state.projects];
      const [moved] = projects.splice(fromIndex, 1);
      if (!moved) return state;
      projects.splice(toIndex, 0, moved);
      try {
        localStorage.setItem(ORDER_KEY, JSON.stringify(projects.map((p) => p.path)));
      } catch { /* ignore */ }
      return { projects };
    });
  },
}));
