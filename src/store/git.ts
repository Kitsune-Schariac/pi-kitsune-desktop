// Git 面板状态 store: 按 cwd 维度存仓库状态, 与 session store 解耦。
// 覆盖: 工作区 status / diff / 写操作 (stage/unstage/commit/checkout) /
// 分支列表 (含 ahead-behind) / 工作树列表 (worktrees) / 提交历史 DAG 图谱 (graph) / 单提交 patch (show)。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// 异步槽位防串台守卫: 每次发起新请求或显式清除槽位递增 epoch, 迟到结果丢弃
let diffEpoch = 0;
let logEpoch = 0;
let graphEpoch = 0;
let showEpoch = 0;
let branchEpoch = 0;
let wtEpoch = 0;

export type GitChangeType =
  | "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";

export interface GitFileChange {
  path: string;
  old_path: string | null;
  staged: GitChangeType | null;
  unstaged: GitChangeType | null;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFileChange[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  head_short: string;
  ahead: number;
  behind: number;
}

export interface GitWorktree {
  path: string;
  head: string;
  branch: string | null;
  is_main: boolean;
  is_current: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_locked: boolean;
  is_prunable: boolean;
}

export interface GitRefBadge {
  name: string;
  kind: "head" | "local" | "remote" | "tag";
}

export interface GitGraphCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: GitRefBadge[];
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitShowResult extends GitLogEntry {
  patch: string;
}

export interface GitDiff {
  patch: string;
  cwd: string;
  path: string;
  staged: boolean;
}

const DEFAULT_GRAPH_LIMIT = 120;

interface GitStore {
  statusByCwd: Record<string, GitStatus | null>;
  loadingByCwd: Record<string, boolean>;
  errorByCwd: Record<string, string | null>;
  diff: GitDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  branches: GitBranch[] | null;
  branchesLoading: boolean;
  worktrees: GitWorktree[] | null;
  worktreesLoading: boolean;
  worktreesError: string | null;
  writing: boolean;
  log: GitLogEntry[] | null;
  logLoading: boolean;
  logError: string | null;
  graph: GitGraphCommit[] | null;
  graphLoading: boolean;
  graphError: string | null;
  graphAll: boolean;
  graphLimit: number;
  show: GitShowResult | null;
  showLoading: boolean;

  loadStatus: (cwd: string) => Promise<void>;
  loadDiff: (cwd: string, path: string, staged: boolean) => Promise<void>;
  clearDiff: () => void;
  loadBranches: (cwd: string) => Promise<void>;
  loadWorktrees: (cwd: string) => Promise<void>;
  loadGraph: (cwd: string, opts?: { all?: boolean; limit?: number }) => Promise<void>;
  stageFiles: (cwd: string, paths: string[]) => Promise<void>;
  unstageFiles: (cwd: string, paths: string[]) => Promise<void>;
  commit: (cwd: string, message: string) => Promise<void>;
  checkout: (cwd: string, branch: string) => Promise<void>;
  loadLog: (cwd: string) => Promise<void>;
  loadShow: (cwd: string, hash: string) => Promise<void>;
  clearShow: () => void;
}

export const useGitStore = create<GitStore>((set, get) => ({
  statusByCwd: {},
  loadingByCwd: {},
  errorByCwd: {},
  diff: null,
  diffLoading: false,
  diffError: null,
  branches: null,
  branchesLoading: false,
  worktrees: null,
  worktreesLoading: false,
  worktreesError: null,
  writing: false,
  log: null,
  logLoading: false,
  logError: null,
  graph: null,
  graphLoading: false,
  graphError: null,
  graphAll: true,
  graphLimit: DEFAULT_GRAPH_LIMIT,
  show: null,
  showLoading: false,

  loadStatus: async (cwd) => {
    set((s) => ({ loadingByCwd: { ...s.loadingByCwd, [cwd]: true } }));
    try {
      const status = await invoke<GitStatus>("git_status", { cwd });
      set((s) => ({
        statusByCwd: { ...s.statusByCwd, [cwd]: status },
        errorByCwd: { ...s.errorByCwd, [cwd]: null },
      }));
    } catch (e) {
      set((s) => ({ errorByCwd: { ...s.errorByCwd, [cwd]: String(e) } }));
    } finally {
      set((s) => ({ loadingByCwd: { ...s.loadingByCwd, [cwd]: false } }));
    }
  },

  loadDiff: async (cwd, path, staged) => {
    const epoch = ++diffEpoch;
    set({ diffLoading: true, diffError: null });
    try {
      const patch = await invoke<string>("git_diff", { cwd, path, staged });
      if (epoch !== diffEpoch) return;
      set({ diff: { patch, cwd, path, staged }, diffLoading: false, diffError: null });
    } catch (e) {
      if (epoch !== diffEpoch) return;
      set({ diffError: String(e), diffLoading: false });
    }
  },

  clearDiff: () => {
    diffEpoch++;
    set({ diff: null, diffError: null, diffLoading: false });
  },

  loadBranches: async (cwd) => {
    const epoch = ++branchEpoch;
    set({ branchesLoading: true });
    try {
      const branches = await invoke<GitBranch[]>("git_branches", { cwd });
      if (epoch !== branchEpoch) return;
      set({ branches });
    } catch {
      if (epoch !== branchEpoch) return;
      set({ branches: null });
    } finally {
      if (epoch === branchEpoch) set({ branchesLoading: false });
    }
  },

  loadWorktrees: async (cwd) => {
    const epoch = ++wtEpoch;
    set({ worktreesLoading: true, worktreesError: null });
    try {
      const worktrees = await invoke<GitWorktree[]>("git_worktrees", { cwd });
      if (epoch !== wtEpoch) return;
      set({ worktrees, worktreesError: null });
    } catch (e) {
      if (epoch !== wtEpoch) return;
      set({ worktrees: null, worktreesError: String(e) });
    } finally {
      if (epoch === wtEpoch) set({ worktreesLoading: false });
    }
  },

  loadGraph: async (cwd, opts) => {
    const epoch = ++graphEpoch;
    const all = opts?.all ?? get().graphAll;
    const limit = opts?.limit ?? get().graphLimit;
    set({ graphLoading: true, graphError: null, graphAll: all, graphLimit: limit });
    try {
      const graph = await invoke<GitGraphCommit[]>("git_graph_log", { cwd, limit, all });
      if (epoch !== graphEpoch) return;
      set({ graph, graphLoading: false, graphError: null });
    } catch (e) {
      if (epoch !== graphEpoch) return;
      set({ graph: null, graphError: String(e), graphLoading: false });
    }
  },

  stageFiles: async (cwd, paths) => {
    set({ writing: true });
    try {
      await invoke("git_stage", { cwd, paths });
      await get().loadStatus(cwd);
      const d = get().diff;
      if (d?.cwd === cwd) await get().loadDiff(d.cwd, d.path, d.staged);
    } finally {
      set({ writing: false });
    }
  },

  unstageFiles: async (cwd, paths) => {
    set({ writing: true });
    try {
      await invoke("git_unstage", { cwd, paths });
      await get().loadStatus(cwd);
      const d = get().diff;
      if (d?.cwd === cwd) await get().loadDiff(d.cwd, d.path, d.staged);
    } finally {
      set({ writing: false });
    }
  },

  commit: async (cwd, message) => {
    set({ writing: true });
    try {
      await invoke("git_commit", { cwd, message });
      await Promise.all([get().loadStatus(cwd), get().loadGraph(cwd)]);
      get().clearDiff();
    } finally {
      set({ writing: false });
    }
  },

  checkout: async (cwd, branch) => {
    set({ writing: true });
    try {
      await invoke("git_checkout", { cwd, branch });
      await Promise.all([
        get().loadStatus(cwd),
        get().loadBranches(cwd),
        get().loadWorktrees(cwd),
        get().loadGraph(cwd),
      ]);
      get().clearDiff();
    } finally {
      set({ writing: false });
    }
  },

  loadLog: async (cwd) => {
    const epoch = ++logEpoch;
    set({ logLoading: true, logError: null });
    try {
      const log = await invoke<GitLogEntry[]>("git_log", { cwd });
      if (epoch !== logEpoch) return;
      set({ log, logLoading: false });
    } catch (e) {
      if (epoch !== logEpoch) return;
      set({ log: null, logError: String(e), logLoading: false });
    }
  },

  loadShow: async (cwd, hash) => {
    const epoch = ++showEpoch;
    set({ showLoading: true });
    try {
      const result = await invoke<GitShowResult>("git_show", { cwd, hash });
      if (epoch !== showEpoch) return;
      set({ show: result });
    } finally {
      if (epoch === showEpoch) set({ showLoading: false });
    }
  },

  clearShow: () => {
    showEpoch++;
    set({ show: null, showLoading: false });
  },
}));
