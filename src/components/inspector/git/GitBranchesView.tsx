import { useMemo } from "react";
import {
  ArrowDown, ArrowUp, Check, FolderGit2, FolderSearch, GitBranch,
  Loader2, Lock, PlusCircle, AlertTriangle,
} from "lucide-react";
import type { GitBranch as GitBranchInfo, GitWorktree } from "../../../store/git";
import { revealPath } from "../../../lib/localPath";
import { useSessionStore } from "../../../store/session";
import { EmptyHint } from "../../ui";

/**
 * Git 「分支」视图: 上半区呈现所有 Worktrees (主工作树 + linked worktrees),
 * 下半区呈现本地分支与 upstream/ahead/behind 及 Worktree 占用状态, 支持一键安全切分支。
 */
export function GitBranchesView({
  branches,
  branchesLoading,
  worktrees,
  worktreesLoading,
  worktreesError,
  writing,
  onCheckout,
}: {
  branches: GitBranchInfo[] | null;
  branchesLoading: boolean;
  worktrees: GitWorktree[] | null;
  worktreesLoading: boolean;
  worktreesError: string | null;
  writing: boolean;
  onCheckout: (branch: string) => void;
}) {
  const startSession = useSessionStore((s) => s.startSession);

  // 分支 → 占用该分支的 worktree (git 不允许在当前工作树 checkout 已被另一 worktree 检出的分支)
  const wtByBranch = useMemo(() => {
    const map = new Map<string, GitWorktree>();
    for (const wt of worktrees ?? []) {
      if (wt.branch) map.set(wt.branch, wt);
    }
    return map;
  }, [worktrees]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-4">
      {/* 工作树区 */}
      <section>
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="flex items-center gap-1 text-meta font-semibold uppercase tracking-wide text-fg-3">
            <FolderGit2 className="h-3 w-3" />
            工作树 ({worktrees?.length ?? 0})
          </span>
          {worktreesLoading && <Loader2 className="h-3 w-3 animate-spin text-fg-4" />}
        </div>

        {worktreesError ? (
          <p className="px-1 text-meta text-err">{worktreesError}</p>
        ) : !worktrees?.length ? (
          !worktreesLoading && (
            <EmptyHint icon={<FolderGit2 className="h-4 w-4" />} title="未检测到工作树" />
          )
        ) : (
          <div className="space-y-2">
            {worktrees.map((wt) => {
              const dirName = wt.path.split(/[\\/]/).pop() || wt.path;
              return (
                <div
                  key={wt.path}
                  className={`rounded-md border px-3 py-2 transition-colors duration-fast ease-out ${
                    wt.is_current
                      ? "border-line-2 bg-card shadow-sm"
                      : "border-edge bg-card"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FolderGit2
                      className={`h-[14px] w-[14px] shrink-0 ${
                        wt.is_current ? "text-ok" : "text-fg-3"
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-label font-medium text-fg">
                      {wt.branch ?? (wt.is_bare ? "(bare)" : "(detached)")}
                    </span>
                    {wt.is_current && (
                      <span className="shrink-0 rounded-sm bg-accent px-1 text-meta font-medium text-on-accent">
                        当前
                      </span>
                    )}
                    {wt.is_main && (
                      <span className="shrink-0 rounded-sm bg-well px-1 text-meta text-fg-3">
                        主树
                      </span>
                    )}
                    {wt.is_locked && (
                      <span title="工作树已锁定" className="text-warn">
                        <Lock className="h-3 w-3" />
                      </span>
                    )}
                    {wt.is_prunable && (
                      <span title="目录已失效 (可 prune)" className="text-err">
                        <AlertTriangle className="h-3 w-3" />
                      </span>
                    )}
                  </div>

                  <div
                    className="mt-1 flex items-center justify-between gap-2 font-mono text-meta text-fg-4"
                    title={wt.path}
                  >
                    <span className="truncate">{dirName} · {wt.path}</span>
                    {wt.head && <span className="shrink-0 text-fg-3">{wt.head.slice(0, 7)}</span>}
                  </div>

                  <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
                    <button
                      type="button"
                      onClick={() => void revealPath(wt.path)}
                      className="flex items-center gap-1 rounded-sm px-2 py-1 text-meta text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
                      title="在资源管理器中打开目录"
                    >
                      <FolderSearch className="h-3 w-3" />
                      定位目录
                    </button>
                    {!wt.is_current && !wt.is_bare && !wt.is_prunable && (
                      <button
                        type="button"
                        onClick={() => void startSession(wt.path)}
                        className="ml-auto flex items-center gap-1 rounded-sm px-2 py-1 text-meta text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
                        title={`在工作树 ${wt.path} 启动新会话`}
                      >
                        <PlusCircle className="h-3 w-3" />
                        新会话
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 本地分支区 */}
      <section>
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="flex items-center gap-1 text-meta font-semibold uppercase tracking-wide text-fg-3">
            <GitBranch className="h-3 w-3" />
            本地分支 ({branches?.length ?? 0})
          </span>
          {branchesLoading && <Loader2 className="h-3 w-3 animate-spin text-fg-4" />}
        </div>

        {!branches?.length ? (
          !branchesLoading && (
            <EmptyHint icon={<GitBranch className="h-4 w-4" />} title="暂无本地分支" />
          )
        ) : (
          <div className="overflow-hidden rounded-md border border-edge bg-card">
            {branches.map((b, idx) => {
              const occupiedWt = wtByBranch.get(b.name);
              const inOtherWt = !!occupiedWt && !occupiedWt.is_current;
              const disabled = b.current || inOtherWt || writing;
              return (
                <button
                  key={b.name}
                  type="button"
                  onClick={() => onCheckout(b.name)}
                  disabled={disabled}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-fast ease-out ${
                    idx > 0 ? "border-t border-line" : ""
                  } ${
                    b.current
                      ? "bg-well/60"
                      : disabled
                        ? "opacity-60"
                        : "hover:bg-hover"
                  }`}
                  title={
                    b.current
                      ? "当前所在分支"
                      : inOtherWt
                        ? `已被工作树 ${occupiedWt.path} 检出`
                        : `切换到分支 ${b.name}`
                  }
                >
                  {b.current ? (
                    <Check className="h-[14px] w-[14px] shrink-0 text-ok" />
                  ) : (
                    <GitBranch className="h-[14px] w-[14px] shrink-0 text-fg-4" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-label font-medium text-fg">
                        {b.name}
                      </span>
                      {inOtherWt && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-well px-1 font-mono text-meta text-fg-3">
                          <FolderGit2 className="h-[10px] w-[10px]" />
                          {occupiedWt.path.split(/[\\/]/).pop()}
                        </span>
                      )}
                    </div>
                    {b.upstream && (
                      <div className="truncate font-mono text-meta text-fg-4">
                        → {b.upstream}
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1 font-mono text-meta tabular-nums">
                    {b.ahead > 0 && (
                      <span className="flex items-center text-ok" title={`领先 ${b.ahead} 提交`}>
                        <ArrowUp className="h-3 w-3" />
                        {b.ahead}
                      </span>
                    )}
                    {b.behind > 0 && (
                      <span className="flex items-center text-warn" title={`落后 ${b.behind} 提交`}>
                        <ArrowDown className="h-3 w-3" />
                        {b.behind}
                      </span>
                    )}
                    {b.head_short && <span className="ml-1 text-fg-4">{b.head_short}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
