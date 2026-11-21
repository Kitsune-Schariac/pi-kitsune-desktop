import { useMemo } from "react";
import { FolderGit2, GitBranch, Loader2, Tag } from "lucide-react";
import type { GitGraphCommit, GitRefBadge, GitWorktree } from "../../../store/git";
import { layoutGitGraph, type GraphRow } from "../../../lib/gitGraph";
import { EmptyHint, Segmented } from "../../ui";

const LANE_W = 14;
const PAD_X = 10;
const ROW_H = 52;
const MID_Y = ROW_H / 2;

const shortHash = (h: string) => h.slice(0, 7);
const fmtDate = (d: string) => d.slice(5, 16); // MM-DD HH:mm

function laneX(col: number): number {
  return PAD_X + col * LANE_W;
}

function renderTopPath(from: number, to: number): string {
  const x1 = laneX(from);
  const x2 = laneX(to);
  if (x1 === x2) return `M ${x1} 0 L ${x2} ${MID_Y}`;
  return `M ${x1} 0 C ${x1} ${MID_Y * 0.55}, ${x2} ${MID_Y * 0.45}, ${x2} ${MID_Y}`;
}

function renderBottomPath(from: number, to: number): string {
  const x1 = laneX(from);
  const x2 = laneX(to);
  if (x1 === x2) return `M ${x1} ${MID_Y} L ${x2} ${ROW_H}`;
  return `M ${x1} ${MID_Y} C ${x1} ${MID_Y + (ROW_H - MID_Y) * 0.55}, ${x2} ${MID_Y + (ROW_H - MID_Y) * 0.45}, ${x2} ${ROW_H}`;
}

function RefPill({ badge }: { badge: GitRefBadge }) {
  if (badge.kind === "head") {
    return (
      <span className="inline-flex max-w-[140px] items-center gap-1 rounded-sm bg-accent px-1 font-mono text-meta font-medium text-on-accent">
        <GitBranch className="h-[10px] w-[10px] shrink-0" />
        <span className="truncate">{badge.name}</span>
      </span>
    );
  }
  if (badge.kind === "tag") {
    return (
      <span className="inline-flex max-w-[110px] items-center gap-1 rounded-sm border border-line bg-well px-1 font-mono text-meta text-warn">
        <Tag className="h-[10px] w-[10px] shrink-0" />
        <span className="truncate">{badge.name}</span>
      </span>
    );
  }
  if (badge.kind === "remote") {
    return (
      <span className="inline-flex max-w-[130px] items-center rounded-sm border border-line bg-well px-1 font-mono text-meta text-fg-3">
        <span className="truncate">{badge.name}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-[130px] items-center gap-1 rounded-sm border border-line-2 bg-card px-1 font-mono text-meta font-medium text-fg">
      <GitBranch className="h-[10px] w-[10px] shrink-0 text-fg-3" />
      <span className="truncate">{badge.name}</span>
    </span>
  );
}

/** Git 提交历史 DAG 拓扑图视图: 泳道连线 + 分支/Tag/Worktree 徽章 + 原地看提交 diff */
export function GitGraphView({
  commits,
  loading,
  error,
  graphAll,
  graphLimit,
  worktrees,
  onToggleAll,
  onLoadMore,
  onSelectCommit,
}: {
  commits: GitGraphCommit[] | null;
  loading: boolean;
  error: string | null;
  graphAll: boolean;
  graphLimit: number;
  worktrees: GitWorktree[] | null;
  onToggleAll: (all: boolean) => void;
  onLoadMore: () => void;
  onSelectCommit: (hash: string) => void;
}) {
  const { rows, maxCols } = useMemo(() => layoutGitGraph(commits ?? []), [commits]);

  // 按 HEAD hash 映射被 linked worktree 挂载的提交, 在节点旁挂精简 worktree 标记
  const wtByHead = useMemo(() => {
    const map = new Map<string, GitWorktree[]>();
    for (const wt of worktrees ?? []) {
      if (!wt.head) continue;
      const list = map.get(wt.head) ?? [];
      list.push(wt);
      map.set(wt.head, list);
    }
    return map;
  }, [worktrees]);

  // 限制 SVG 宽度上限, 避免极多并行分支把提交文字挤没
  const clampedCols = Math.min(maxCols, 8);
  const svgW = PAD_X * 2 + Math.max(clampedCols - 1, 0) * LANE_W;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 图谱范围切换栏 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
        <Segmented
          size="sm"
          value={graphAll ? "all" : "current"}
          onChange={(v) => onToggleAll(v === "all")}
          ariaLabel="提交图谱范围"
          options={[
            { value: "all", label: "全部分支" },
            { value: "current", label: "当前分支" },
          ]}
        />
        {commits && commits.length > 0 && (
          <span className="font-mono text-meta tabular-nums text-fg-4">
            {commits.length} 条提交
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="px-4 py-6 text-body text-err">{error}</p>
        ) : loading && !commits ? (
          <div className="flex items-center justify-center gap-2 py-10 text-label text-fg-3">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            构建提交图谱…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyHint icon={<GitBranch className="h-4 w-4" />} title="暂无提交记录" />
          </div>
        ) : (
          <>
            {rows.map((row) => (
              <GraphRowItem
                key={row.commit.hash}
                row={row}
                svgW={svgW}
                linkedWorktrees={wtByHead.get(row.commit.hash)}
                onSelect={onSelectCommit}
              />
            ))}
            {commits && commits.length >= graphLimit && (
              <div className="p-3 text-center">
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={loading}
                  className="rounded-md border border-line bg-card px-3 py-1 text-meta text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg disabled:opacity-40"
                >
                  {loading ? "加载中…" : "加载更多提交"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GraphRowItem({
  row,
  svgW,
  linkedWorktrees,
  onSelect,
}: {
  row: GraphRow;
  svgW: number;
  linkedWorktrees?: GitWorktree[];
  onSelect: (hash: string) => void;
}) {
  const { commit } = row;
  const cx = laneX(row.col);
  // 只给非主工作树的 linked worktree 单独显示微标 (主工作树已由 HEAD/分支徽章体现)
  const extraWt = linkedWorktrees?.filter((w) => !w.is_main) ?? [];

  return (
    <button
      type="button"
      onClick={() => onSelect(commit.hash)}
      className="flex w-full items-stretch border-b border-line pr-3 text-left transition-colors duration-fast ease-out hover:bg-hover"
      style={{ minHeight: ROW_H }}
    >
      <svg
        width={svgW}
        height={ROW_H}
        className="shrink-0 overflow-visible"
        aria-hidden="true"
      >
        {row.topLines.map((l, i) => (
          <path
            key={`t-${i}`}
            d={renderTopPath(l.from, l.to)}
            fill="none"
            stroke={l.color}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
        ))}
        {row.bottomLines.map((l, i) => (
          <path
            key={`b-${i}`}
            d={renderBottomPath(l.from, l.to)}
            fill="none"
            stroke={l.color}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
        ))}
        {row.isMerge ? (
          <circle
            cx={cx}
            cy={MID_Y}
            r={4}
            fill="var(--pane)"
            stroke={row.color}
            strokeWidth={2}
          />
        ) : (
          <circle
            cx={cx}
            cy={MID_Y}
            r={3.5}
            fill={row.color}
            stroke="var(--pane)"
            strokeWidth={1.25}
          />
        )}
      </svg>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 py-2 pl-1">
        {(commit.refs.length > 0 || extraWt.length > 0) && (
          <div className="flex flex-wrap items-center gap-1">
            {commit.refs.slice(0, 4).map((r, i) => (
              <RefPill key={`${r.kind}-${r.name}-${i}`} badge={r} />
            ))}
            {commit.refs.length > 4 && (
              <span className="font-mono text-meta text-fg-4">+{commit.refs.length - 4}</span>
            )}
            {extraWt.map((wt) => (
              <span
                key={wt.path}
                className="inline-flex max-w-[120px] items-center gap-1 rounded-sm bg-well px-1 font-mono text-meta text-fg-2"
                title={`Worktree: ${wt.path}`}
              >
                <FolderGit2 className="h-[10px] w-[10px] shrink-0 text-ok" />
                <span className="truncate">{wt.path.split(/[\\/]/).pop()}</span>
              </span>
            ))}
          </div>
        )}
        <div className="truncate text-label font-medium text-fg" title={commit.subject}>
          {commit.subject}
        </div>
        <div className="flex items-center gap-2 text-meta text-fg-4">
          <span className="truncate">{commit.author}</span>
          <span>·</span>
          <span className="shrink-0 tabular-nums">{fmtDate(commit.date)}</span>
          <span className="ml-auto shrink-0 font-mono text-fg-3">{shortHash(commit.hash)}</span>
        </div>
      </div>
    </button>
  );
}
