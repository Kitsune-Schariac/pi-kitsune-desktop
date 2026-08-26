// Git 面板状态 store: 按 cwd 维度存仓库状态, 与 session store 解耦。
// Git 状态属于仓库不属于会话 —— 同一项目的多个会话应看到同一份仓库状态 (design 四)。
// 写操作 (stage/unstage/commit/checkout) 成功后刷新 status, 让文件列表即时反映变化;
// agent_settled 自动刷新在 session.ts 接入 (模型改完文件正是仓库状态最可能变化的时刻)。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// 异步槽位防串台守卫: 快速连点文件/提交、反复进出视图时, 旧请求迟到的 resolve/reject
// 不得污染新视图 (check P1/P2/P3 同根因, 统一用此模式收口)。每次发起新请求或显式
// 清除槽位都递增对应 epoch, 迟到结果与当前值不符即丢弃。
let diffEpoch = 0;
let logEpoch = 0;
let showEpoch = 0;

// Rust 侧 (git.rs) 结构体未加 serde rename_all, 字段 snake_case 原样透传。
// 前端类型必须对齐 old_path 等下划线字段, 否则拿到 undefined。
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
}

// 提交历史条目 (PRD R5): git_log 返回, Rust 侧 S1 已就绪, 前端 S5 接入
export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

// 单提交完整 patch (PRD R5): git_show 返回, extends GitLogEntry 加 patch 原文交 DiffView
export interface GitShowResult extends GitLogEntry {
  patch: string;
}

// 当前 diff: 单次拉取, 不按 cwd 缓存 (diff 随选中文件/暂存侧变化, 缓存复杂度不值得)
export interface GitDiff {
  patch: string;
  cwd: string;
  path: string;
  staged: boolean;
}

interface GitStore {
  statusByCwd: Record<string, GitStatus | null>;
  loadingByCwd: Record<string, boolean>;
  errorByCwd: Record<string, string | null>;
  diff: GitDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  // 分支列表: 单次拉取 (切换分支时弹出选择), 切换后重拉
  branches: GitBranch[] | null;
  branchesLoading: boolean;
  // 写操作进行中 (提交/暂存/切分支), 禁用触发按钮防重复点击
  writing: boolean;
  // 提交历史 (history 视图用): 单次拉取, 重进视图/切仓库时重拉
  log: GitLogEntry[] | null;
  logLoading: boolean;
  logError: string | null;
  // 单提交完整 patch (commit 视图用): 切提交重拉; 失败不 catch (re-throw) 让组件 local state 展示
  show: GitShowResult | null;
  showLoading: boolean;

  loadStatus: (cwd: string) => Promise<void>;
  loadDiff: (cwd: string, path: string, staged: boolean) => Promise<void>;
  clearDiff: () => void;
  loadBranches: (cwd: string) => Promise<void>;
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
  writing: false,
  log: null,
  logLoading: false,
  logError: null,
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
      // 未装 git: Rust 返回中文提示「未找到 git 命令」; 其余非零退出 stderr 原样上抛。
      // 两者都是面板内红字展示, 与「非仓库」(is_repo=false, 安静降级) 区别开。
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
      // 成功分支显式清 error: 失败→成功切换时不能残留上一次的错误文案 (check P2)
      set({ diff: { patch, cwd, path, staged }, diffLoading: false, diffError: null });
    } catch (e) {
      if (epoch !== diffEpoch) return;
      set({ diffError: String(e), diffLoading: false });
    }
  },

  // 清除也递增 epoch: in-flight 的旧请求返回后不得把已清除的槽位重新填上
  clearDiff: () => {
    diffEpoch++;
    set({ diff: null, diffError: null, diffLoading: false });
  },

  loadBranches: async (cwd) => {
    set({ branchesLoading: true });
    try {
      const branches = await invoke<GitBranch[]>("git_branches", { cwd });
      set({ branches });
    } catch {
      // 分支列表是次要功能, 失败安静降级 (弹层内提示), 不污染面板主错误位
      set({ branches: null });
    } finally {
      set({ branchesLoading: false });
    }
  },

  // 写操作成功后刷新 status 让文件列表即时反映变化; invoke 失败直接抛出 (finally 只复位
  // writing), 不吞错误 —— 组件 catch 后在面板内红字展示, 用户需知道为什么失败 (如 hook 拒绝)。
  stageFiles: async (cwd, paths) => {
    set({ writing: true });
    try {
      await invoke("git_stage", { cwd, paths });
      await get().loadStatus(cwd);
      // 当前 diff 属于同一仓库则重拉, 反映暂存态变化 (文件跨组后原侧 diff 可能变空)
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
      await get().loadStatus(cwd);
      // 提交后暂存区清空, 原 staged 侧 diff 已无意义, 清掉让用户重选
      get().clearDiff();
    } finally {
      set({ writing: false });
    }
  },

  checkout: async (cwd, branch) => {
    set({ writing: true });
    try {
      await invoke("git_checkout", { cwd, branch });
      await get().loadStatus(cwd);
      // 切分支后选中文件可能不存在于新分支, 清 diff 让用户重选
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
      // 历史拉取失败 (如损坏仓库) 在 history 视图内红字展示 (spec: 面板级错误在面板内)
      if (epoch !== logEpoch) return;
      set({ log: null, logError: String(e), logLoading: false });
    }
  },

  loadShow: async (cwd, hash) => {
    const epoch = ++showEpoch;
    set({ showLoading: true });
    try {
      const result = await invoke<GitShowResult>("git_show", { cwd, hash });
      // 过期结果不进 store: showMatches 只校验 hash, 挡不住 loading 被旧 finally 误关
      if (epoch !== showEpoch) return;
      set({ show: result });
    } finally {
      // 失败不 catch (re-throw) —— 组件 await 时 catch 后用 local state 展示
      // (design: 视图切换是纯前端状态, 错误也归视图内, 切 hash 自动清)
      if (epoch === showEpoch) set({ showLoading: false });
    }
  },

  clearShow: () => {
    showEpoch++;
    set({ show: null, showLoading: false });
  },
}));