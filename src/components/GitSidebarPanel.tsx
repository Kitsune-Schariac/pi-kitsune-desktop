// Git 侧栏面板: 三段式顶级视图 (变更 | 图谱 | 分支) + 原地 Diff / Commit 详情钻取。
// 写操作 (提交 / 切分支) 保留二次确认弹层 (单次误点不触发), 错误原样展示不吞 stderr。
// Esc 优先级: confirm 弹层 → diff/commit 详情返回上级视图。
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  X, RefreshCw, Loader2, GitBranch, ArrowUp, ArrowDown, FilePen,
  FilePlus2, FileMinus2, ArrowRightLeft, FileQuestion, AlertTriangle, FileText,
  Plus, Minus, GitCommitHorizontal, ChevronLeft, GitGraph, FolderGit2,
} from "lucide-react";
import { useGitStore } from "../store/git";
import type { GitFileChange, GitChangeType } from "../store/git";
import { DiffView } from "./DiffView";
import { GitGraphView } from "./inspector/git/GitGraphView";
import { GitBranchesView } from "./inspector/git/GitBranchesView";
import { EmptyHint, Segmented } from "./ui";

const CHANGE_META: Record<GitChangeType, { label: string; code: string; cls: string; Icon: typeof FilePen }> = {
  modified: { label: "修改", code: "M", cls: "text-warn", Icon: FilePen },
  added: { label: "新增", code: "A", cls: "text-ok", Icon: FilePlus2 },
  deleted: { label: "删除", code: "D", cls: "text-err", Icon: FileMinus2 },
  renamed: { label: "重命名", code: "R", cls: "text-warn", Icon: ArrowRightLeft },
  untracked: { label: "未跟踪", code: "U", cls: "text-ok", Icon: FileQuestion },
  conflict: { label: "冲突", code: "!", cls: "text-err", Icon: AlertTriangle },
};

type SubTab = "changes" | "graph" | "branches";
type DetailView =
  | null
  | { kind: "diff"; path: string; staged: boolean }
  | { kind: "commit"; hash: string };

interface Props {
  cwd?: string;
  onClose?: () => void;
}

// 处理 git 特有的 /dev/null 形态: 逐段以 `diff --git` 切片做对侧路径替换, 让 DiffView 文件头干净
function normalizePatchHead(patch: string): string {
  return patch
    .split(/(?=^diff --git )/m)
    .map((seg) => {
      if (seg.includes("--- /dev/null")) {
        const m = seg.match(/^\+\+\+ (.+)$/m);
        if (m) seg = seg.replace("--- /dev/null", `--- ${m[1]}`);
      }
      if (seg.includes("+++ /dev/null")) {
        const m = seg.match(/^--- (.+)$/m);
        if (m) seg = seg.replace("+++ /dev/null", `+++ ${m[1]}`);
      }
      return seg;
    })
    .join("");
}

const fmtDate = (d: string) => d.slice(0, 16);
const shortHash = (h: string) => h.slice(0, 7);

export function GitSidebarPanel({ cwd, onClose }: Props) {
  const status = useGitStore((s) => (cwd ? s.statusByCwd[cwd] ?? null : null));
  const loading = useGitStore((s) => (cwd ? s.loadingByCwd[cwd] ?? false : false));
  const error = useGitStore((s) => (cwd ? s.errorByCwd[cwd] ?? null : null));
  const branches = useGitStore((s) => s.branches);
  const branchesLoading = useGitStore((s) => s.branchesLoading);
  const worktrees = useGitStore((s) => s.worktrees);
  const worktreesLoading = useGitStore((s) => s.worktreesLoading);
  const worktreesError = useGitStore((s) => s.worktreesError);
  const writing = useGitStore((s) => s.writing);
  const diff = useGitStore((s) => s.diff);
  const diffLoading = useGitStore((s) => s.diffLoading);
  const diffError = useGitStore((s) => s.diffError);
  const graph = useGitStore((s) => s.graph);
  const graphLoading = useGitStore((s) => s.graphLoading);
  const graphError = useGitStore((s) => s.graphError);
  const graphAll = useGitStore((s) => s.graphAll);
  const graphLimit = useGitStore((s) => s.graphLimit);
  const show = useGitStore((s) => s.show);
  const showLoading = useGitStore((s) => s.showLoading);

  const loadStatus = useGitStore((s) => s.loadStatus);
  const loadBranches = useGitStore((s) => s.loadBranches);
  const loadWorktrees = useGitStore((s) => s.loadWorktrees);
  const loadGraph = useGitStore((s) => s.loadGraph);
  const stageFiles = useGitStore((s) => s.stageFiles);
  const unstageFiles = useGitStore((s) => s.unstageFiles);
  const commit = useGitStore((s) => s.commit);
  const checkout = useGitStore((s) => s.checkout);
  const loadDiff = useGitStore((s) => s.loadDiff);
  const clearDiff = useGitStore((s) => s.clearDiff);
  const loadShow = useGitStore((s) => s.loadShow);
  const clearShow = useGitStore((s) => s.clearShow);

  const [subTab, setSubTab] = useState<SubTab>("changes");
  const [detail, setDetail] = useState<DetailView>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [showError, setShowError] = useState<string | null>(null);
  const showEpochRef = useRef(0);
  const [confirm, setConfirm] = useState<null | {
    title: string;
    message: string;
    confirmText: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }>(null);

  // 切项目重置视图并拉取仓库状态
  useEffect(() => {
    if (cwd) loadStatus(cwd);
    setCommitMsg("");
    setActionError(null);
    setDetail(null);
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // 按需拉取图谱 / 分支与工作树数据
  useEffect(() => {
    if (!cwd || !status?.is_repo) return;
    if (subTab === "graph") {
      void loadGraph(cwd);
      void loadWorktrees(cwd);
    } else if (subTab === "branches") {
      void loadBranches(cwd);
      void loadWorktrees(cwd);
    }
  }, [cwd, status?.is_repo, subTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // 原地详情视图数据拉取与清理
  useEffect(() => {
    if (!cwd) return;
    if (detail?.kind === "diff") {
      void loadDiff(cwd, detail.path, detail.staged);
    } else if (detail?.kind === "commit") {
      setShowError(null);
      const epoch = ++showEpochRef.current;
      loadShow(cwd, detail.hash).catch((e) => {
        if (epoch === showEpochRef.current) setShowError(String(e));
      });
    }
  }, [detail, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (detail?.kind !== "diff") clearDiff();
    if (detail?.kind !== "commit") clearShow();
  }, [detail]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc 优先级: confirm 弹层 → diff/commit 返回上级
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirm) { setConfirm(null); return; }
      if (detail) { setDetail(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, detail]);

  const groups = useMemo(() => {
    const staged: GitFileChange[] = [];
    const unstaged: GitFileChange[] = [];
    const untracked: GitFileChange[] = [];
    for (const f of status?.files ?? []) {
      if (f.staged) staged.push(f);
      if (f.unstaged && f.unstaged !== "untracked") unstaged.push(f);
      if (f.unstaged === "untracked") untracked.push(f);
    }
    return { staged, unstaged, untracked };
  }, [status]);

  const hasStaged = groups.staged.length > 0;
  const allUnstagedPaths = useMemo(
    () => [...groups.unstaged, ...groups.untracked].map((f) => f.path),
    [groups],
  );
  const allStagedPaths = useMemo(() => groups.staged.map((f) => f.path), [groups]);
  const hasUnstaged = allUnstagedPaths.length > 0;

  const diffMatches =
    !!diff && detail?.kind === "diff" &&
    diff.cwd === cwd && diff.path === detail.path && diff.staged === detail.staged;
  const viewPatch = useMemo(() => (diff ? normalizePatchHead(diff.patch) : ""), [diff]);

  const selectedType = useMemo<GitChangeType | null>(() => {
    if (detail?.kind !== "diff") return null;
    const f = status?.files.find((x) => x.path === detail.path);
    return f ? (detail.staged ? f.staged : f.unstaged) : null;
  }, [status, detail]);
  const selectedMeta = selectedType ? CHANGE_META[selectedType] : null;
  const SelectedIcon = selectedMeta?.Icon;

  const showMatches = detail?.kind === "commit" && !!show && show.hash === detail.hash;
  const showPatch = useMemo(() => (show ? normalizePatchHead(show.patch) : ""), [show]);

  const handleRefresh = () => {
    if (!cwd) return;
    void loadStatus(cwd);
    if (subTab === "graph") {
      void loadGraph(cwd);
      void loadWorktrees(cwd);
    } else if (subTab === "branches") {
      void loadBranches(cwd);
      void loadWorktrees(cwd);
    }
  };

  const handleStage = async (paths: string[]) => {
    if (!cwd || writing || paths.length === 0) return;
    try {
      await stageFiles(cwd, paths);
      setActionError(null);
    } catch (e) {
      setActionError(`暂存失败: ${String(e)}`);
    }
  };

  const handleUnstage = async (paths: string[]) => {
    if (!cwd || writing || paths.length === 0) return;
    try {
      await unstageFiles(cwd, paths);
      setActionError(null);
    } catch (e) {
      setActionError(`取消暂存失败: ${String(e)}`);
    }
  };

  const askCommit = () => {
    const msg = commitMsg.trim();
    if (!cwd || !msg || !hasStaged || writing) return;
    setConfirm({
      title: "确认提交",
      message: `将提交 ${groups.staged.length} 个暂存文件，提交信息：\n\n${msg}`,
      confirmText: "提交",
      onConfirm: async () => {
        setConfirm(null);
        try {
          await commit(cwd, msg);
          setCommitMsg("");
          setActionError(null);
        } catch (e) {
          setActionError(`提交失败: ${String(e)}`);
        }
      },
      onCancel: () => setConfirm(null),
    });
  };

  const askCheckout = (branch: string) => {
    if (!cwd || writing) return;
    const dirtyCount = (status?.files ?? []).length;
    setConfirm({
      title: "切换分支",
      message: dirtyCount > 0
        ? `工作区有 ${dirtyCount} 个未提交改动，切换到「${branch}」可能导致冲突或阻挡。确定切换？`
        : `切换到分支「${branch}」？`,
      confirmText: "切换",
      danger: dirtyCount > 0,
      onConfirm: async () => {
        setConfirm(null);
        try {
          await checkout(cwd, branch);
          setActionError(null);
        } catch (e) {
          setActionError(`切换分支失败: ${String(e)}`);
        }
      },
      onCancel: () => setConfirm(null),
    });
  };

  const refreshing = loading || (subTab === "graph" && graphLoading) || (subTab === "branches" && (branchesLoading || worktreesLoading));
  const changeCount = status?.files.length ?? 0;

  return (
    <>
      {detail?.kind === "diff" ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="flex items-center rounded-md p-1 text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
              title="返回 (Esc)"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex min-w-0 items-center gap-2">
              {selectedMeta && SelectedIcon && (
                <span className={`flex shrink-0 items-center gap-1 text-meta ${selectedMeta.cls}`}>
                  <SelectedIcon className="h-[14px] w-[14px]" />
                  {selectedMeta.label}
                </span>
              )}
              <span className="truncate font-mono text-meta text-fg-2" title={detail.path}>
                {detail.path}
              </span>
              {detail.staged && <span className="shrink-0 text-meta text-fg-3">· 已暂存</span>}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {diffError ? (
              <p className="px-4 py-6 text-body text-err">{diffError}</p>
            ) : diffLoading && !diffMatches ? (
              <Hint icon={<Loader2 className="h-4 w-4 animate-spin text-accent" />} text="加载差异…" />
            ) : diffMatches ? (
              <div className="p-3">
                <DiffView patch={viewPatch} cwd={cwd} />
              </div>
            ) : (
              <Hint text="加载差异…" />
            )}
          </div>
        </>
      ) : detail?.kind === "commit" ? (
        <>
          <div className="shrink-0 border-b border-line">
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="flex items-center rounded-md p-1 text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
                title="返回提交图谱 (Esc)"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-label font-medium text-fg" title={showMatches ? show?.subject : ""}>
                  {showMatches ? show?.subject : "加载提交…"}
                </span>
                <span className="shrink-0 font-mono text-meta text-fg-3">{shortHash(detail.hash)}</span>
              </div>
            </div>
            {showMatches && show && (
              <div className="flex items-center gap-2 px-3 pb-2 text-meta text-fg-3">
                <span className="truncate">{show.author}</span>
                <span>·</span>
                <span className="tabular-nums">{fmtDate(show.date)}</span>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {showError ? (
              <p className="px-4 py-6 text-body text-err">{showError}</p>
            ) : showLoading && !showMatches ? (
              <Hint icon={<Loader2 className="h-4 w-4 animate-spin text-accent" />} text="加载提交 Patch…" />
            ) : showMatches && show ? (
              <div className="p-3">
                <DiffView patch={showPatch} cwd={cwd} />
              </div>
            ) : (
              <Hint text="加载中…" />
            )}
          </div>
        </>
      ) : (
        <>
          {/* 顶部当前分支状态栏 */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch className="h-[14px] w-[14px] shrink-0 text-fg-3" />
              {status?.is_repo && status.branch ? (
                <button
                  type="button"
                  onClick={() => setSubTab("branches")}
                  className="truncate font-mono text-body font-medium text-fg transition-colors duration-fast ease-out hover:text-fg-2"
                  title="查看全部分支与工作树"
                >
                  {status.branch}
                </button>
              ) : (
                <span className="text-label text-fg-3">—</span>
              )}
              {status?.upstream && (
                <span className="truncate font-mono text-meta text-fg-4" title={`追踪 ${status.upstream}`}>
                  · {status.upstream}
                </span>
              )}
              {!!status?.ahead && (
                <span className="flex shrink-0 items-center font-mono text-meta tabular-nums text-ok" title={`领先 ${status.ahead} 提交`}>
                  <ArrowUp className="h-3 w-3" />
                  {status.ahead}
                </span>
              )}
              {!!status?.behind && (
                <span className="flex shrink-0 items-center font-mono text-meta tabular-nums text-warn" title={`落后 ${status.behind} 提交`}>
                  <ArrowDown className="h-3 w-3" />
                  {status.behind}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={handleRefresh}
                disabled={!cwd || refreshing}
                className="grid h-7 w-7 place-items-center rounded-md text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg disabled:opacity-40"
                title="刷新 Git 状态"
              >
                <RefreshCw className={`h-[14px] w-[14px] ${refreshing ? "animate-spin" : ""}`} />
              </button>
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="grid h-7 w-7 place-items-center rounded-md text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
                  title="收起"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* 有效仓库时显示三视图切换: 变更 | 图谱 | 分支 */}
          {cwd && status?.is_repo && (
            <div className="shrink-0 border-b border-line px-3 py-2">
              <Segmented
                size="sm"
                fill
                value={subTab}
                onChange={setSubTab}
                ariaLabel="Git 视图"
                options={[
                  {
                    value: "changes",
                    label: (
                      <>
                        <FilePen className="h-3 w-3" />
                        <span>变更</span>
                        {changeCount > 0 && (
                          <span className="font-mono text-meta tabular-nums text-fg-4">
                            {changeCount}
                          </span>
                        )}
                      </>
                    ),
                  },
                  {
                    value: "graph",
                    label: (
                      <>
                        <GitGraph className="h-3 w-3" />
                        <span>图谱</span>
                      </>
                    ),
                  },
                  {
                    value: "branches",
                    label: (
                      <>
                        <FolderGit2 className="h-3 w-3" />
                        <span>分支</span>
                        {worktrees && worktrees.length > 1 && (
                          <span className="font-mono text-meta tabular-nums text-fg-4">
                            {worktrees.length}
                          </span>
                        )}
                      </>
                    ),
                  },
                ]}
              />
            </div>
          )}

          {/* 面板内错误条 (写操作失败如 hook 拒绝 / checkout 被脏区阻挡) */}
          {actionError && (
            <div className="flex shrink-0 items-start gap-2 border-b border-line bg-well px-3 py-2 text-meta text-err">
              <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1 whitespace-pre-line">{actionError}</span>
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="shrink-0 text-fg-4 hover:text-fg"
                title="关闭错误"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* 主内容按状态与 subTab 分发 */}
          {!cwd ? (
            <div className="p-4">
              <EmptyHint icon={<GitBranch className="h-5 w-5" />} title="暂无工作目录">
                请先打开一个项目会话
              </EmptyHint>
            </div>
          ) : loading && !status ? (
            <Hint icon={<Loader2 className="h-4 w-4 animate-spin text-accent" />} text="读取仓库状态…" />
          ) : error ? (
            <p className="px-4 py-6 text-body text-err">{error}</p>
          ) : !status?.is_repo ? (
            <div className="p-4">
              <EmptyHint icon={<GitBranch className="h-5 w-5" />} title="非 Git 仓库">
                当前目录未初始化 Git 版本库
              </EmptyHint>
            </div>
          ) : subTab === "graph" ? (
            <GitGraphView
              commits={graph}
              loading={graphLoading}
              error={graphError}
              graphAll={graphAll}
              graphLimit={graphLimit}
              worktrees={worktrees}
              onToggleAll={(all) => void loadGraph(cwd, { all, limit: 120 })}
              onLoadMore={() => void loadGraph(cwd, { all: graphAll, limit: graphLimit + 100 })}
              onSelectCommit={(hash) => setDetail({ kind: "commit", hash })}
            />
          ) : subTab === "branches" ? (
            <GitBranchesView
              branches={branches}
              branchesLoading={branchesLoading}
              worktrees={worktrees}
              worktreesLoading={worktreesLoading}
              worktreesError={worktreesError}
              writing={writing}
              onCheckout={askCheckout}
            />
          ) : (
            <>
              {(hasStaged || hasUnstaged) && (
                <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
                  <button
                    type="button"
                    onClick={() => handleStage(allUnstagedPaths)}
                    disabled={writing || !hasUnstaged}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-meta text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg disabled:opacity-40"
                    title="暂存所有未暂存与未跟踪文件"
                  >
                    <Plus className="h-3 w-3" />
                    全部暂存
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUnstage(allStagedPaths)}
                    disabled={writing || !hasStaged}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-meta text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg disabled:opacity-40"
                    title="取消所有暂存"
                  >
                    <Minus className="h-3 w-3" />
                    全部取消暂存
                  </button>
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto">
                {status.files.length === 0 ? (
                  <div className="p-4">
                    <EmptyHint icon={<GitCommitHorizontal className="h-5 w-5" />} title="工作区干净">
                      没有未提交的本地修改
                    </EmptyHint>
                  </div>
                ) : (
                  <>
                    <FileGroup
                      title="已暂存"
                      items={groups.staged}
                      side="staged"
                      onSelect={(s) => setDetail({ kind: "diff", path: s.path, staged: s.staged })}
                      writing={writing}
                      onUnstageFile={(p) => handleUnstage([p])}
                    />
                    <FileGroup
                      title="未暂存"
                      items={groups.unstaged}
                      side="unstaged"
                      onSelect={(s) => setDetail({ kind: "diff", path: s.path, staged: s.staged })}
                      writing={writing}
                      onStageFile={(p) => handleStage([p])}
                    />
                    <FileGroup
                      title="未跟踪"
                      items={groups.untracked}
                      side="unstaged"
                      onSelect={(s) => setDetail({ kind: "diff", path: s.path, staged: s.staged })}
                      writing={writing}
                      onStageFile={(p) => handleStage([p])}
                    />
                  </>
                )}
              </div>

              {/* 底部提交区 */}
              <div className="shrink-0 border-t border-line p-3">
                <textarea
                  value={commitMsg}
                  onChange={(e) => { setCommitMsg(e.target.value); setActionError(null); }}
                  placeholder="输入提交信息…"
                  rows={2}
                  disabled={!hasStaged || writing}
                  className="w-full resize-none rounded-md border border-line bg-well px-2 py-2 text-label text-fg placeholder:text-fg-4 focus:border-line-2 focus:outline-none disabled:opacity-50"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={askCommit}
                    disabled={!hasStaged || !commitMsg.trim() || writing}
                    className="flex items-center gap-1 rounded-md bg-accent px-3 py-2 text-label font-medium text-on-accent transition-opacity duration-fast ease-out hover:opacity-90 disabled:opacity-40"
                  >
                    <GitCommitHorizontal className="h-[14px] w-[14px]" />
                    提交 ({groups.staged.length})
                  </button>
                  {!hasStaged && <span className="text-meta text-fg-4">无暂存改动</span>}
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* 二次确认弹层 (提交 / 切分支共用) */}
      {confirm && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) confirm.onCancel();
          }}
        >
          <div className="w-96 overflow-hidden rounded-xl border border-edge bg-popover shadow-lg view-in-soft">
            <div className="border-b border-line px-4 py-3 text-lead font-medium">{confirm.title}</div>
            <div className="whitespace-pre-line px-4 py-4 text-body text-fg-2">{confirm.message}</div>
            <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
              <button
                type="button"
                onClick={confirm.onCancel}
                className="rounded-md px-3 py-2 text-label text-fg-2 transition-colors duration-fast ease-out hover:bg-hover"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirm.onConfirm}
                disabled={writing}
                className={`rounded-md px-3 py-2 text-label font-medium text-on-accent transition-opacity duration-fast ease-out disabled:opacity-40 ${
                  confirm.danger ? "bg-err hover:opacity-90" : "bg-accent hover:opacity-90"
                }`}
              >
                {confirm.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function FileGroup({
  title,
  items,
  side,
  onSelect,
  writing,
  onStageFile,
  onUnstageFile,
}: {
  title: string;
  items: GitFileChange[];
  side: "staged" | "unstaged";
  onSelect: (s: { path: string; staged: boolean }) => void;
  writing: boolean;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
}) {
  if (items.length === 0) return null;
  const isStaged = side === "staged";
  const fileAction = isStaged ? onUnstageFile : onStageFile;
  const ActionIcon = isStaged ? Minus : Plus;
  const actionLabel = isStaged ? "取消暂存" : "暂存";
  return (
    <div className="py-1">
      <div className="px-3 py-1 text-meta font-semibold uppercase tracking-wide text-fg-4">
        {title} ({items.length})
      </div>
      {items.map((f) => {
        const type = side === "staged" ? f.staged : f.unstaged;
        const meta = type ? CHANGE_META[type] : null;
        const Icon = meta?.Icon ?? FileText;
        const norm = f.path.replace(/\\/g, "/");
        const slash = norm.lastIndexOf("/");
        const base = slash >= 0 ? norm.slice(slash + 1) : norm;
        const dir = slash >= 0 ? norm.slice(0, slash) : "";

        return (
          <div key={f.path} className="group flex items-center transition-colors duration-fast ease-out hover:bg-hover">
            <button
              type="button"
              onClick={() => onSelect({ path: f.path, staged: isStaged })}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left transition-colors duration-fast ease-out"
              title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
            >
              <Icon className={`h-[14px] w-[14px] shrink-0 ${meta?.cls ?? "text-fg-3"}`} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-mono text-label text-fg-2 group-hover:text-fg">{base}</span>
                {dir && <span className="ml-2 font-mono text-meta text-fg-4">{dir}</span>}
              </span>
              {meta && (
                <span className={`shrink-0 font-mono text-meta font-semibold ${meta.cls}`}>
                  {meta.code}
                </span>
              )}
            </button>
            {fileAction && (
              <button
                type="button"
                onClick={() => fileAction(f.path)}
                disabled={writing}
                className="mr-2 shrink-0 rounded-sm p-1 text-fg-3 opacity-0 transition-opacity duration-fast ease-out hover:text-fg group-hover:opacity-100 disabled:opacity-40"
                title={actionLabel}
              >
                <ActionIcon className="h-[14px] w-[14px]" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Hint({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-label text-fg-3">
      {icon}
      {text}
    </div>
  );
}
