// Git 提交历史 DAG 泳道布局纯函数 (零 DOM / store 依赖)。
// 输入按 --topo-order 排序的提交列表, 为每一行算出:
// - 节点所在泳道 col 及颜色
// - 上半区 (y=0 → midY): 哪些泳道从上方连进来、哪些重复泳道向当前节点合流
// - 下半区 (midY → rowH): 当前节点分叉/连向父提交的边, 以及其余直通泳道
import type { GitGraphCommit } from "../store/git";

const VIZ_COLORS = [
  "var(--viz-1)",
  "var(--viz-2)",
  "var(--viz-3)",
  "var(--viz-5)",
  "var(--viz-6)",
  "var(--viz-4)",
];

export interface LaneLine {
  from: number;
  to: number;
  color: string;
}

export interface GraphRow {
  commit: GitGraphCommit;
  col: number;
  color: string;
  isMerge: boolean;
  /** 从行顶 (y=0) 连到行中 (y=mid) 的线 (包含直通列和合流到当前节点的列) */
  topLines: LaneLine[];
  /** 从行中 (y=mid) 连到行底 (y=h) 的线 (包含直通列和连向各 parent 的分叉/合流线) */
  bottomLines: LaneLine[];
  /** 当前行需要渲染的泳道总数 (用于计算该行及全局 SVG 宽度) */
  widthCols: number;
}

interface ActiveLane {
  /** 该泳道正在等待连接的 commit hash */
  expected: string;
  color: string;
}

export function layoutGitGraph(commits: GitGraphCommit[]): { rows: GraphRow[]; maxCols: number } {
  const lanes: (ActiveLane | null)[] = [];
  let nextColor = 0;
  let maxCols = 1;

  const allocColor = () => VIZ_COLORS[nextColor++ % VIZ_COLORS.length];

  const findFreeCol = (): number => {
    const idx = lanes.findIndex((l) => l === null);
    if (idx >= 0) return idx;
    lanes.push(null);
    return lanes.length - 1;
  };

  const rows: GraphRow[] = [];

  for (const commit of commits) {
    // 1. 找到所有等待当前 commit 的泳道
    const matchingCols: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]?.expected === commit.hash) matchingCols.push(i);
    }

    let col: number;
    let color: string;
    const topLines: LaneLine[] = [];

    if (matchingCols.length > 0) {
      // 最左边的匹配泳道作为当前节点所在列
      col = matchingCols[0];
      color = lanes[col]!.color;
    } else {
      // 新分支顶端 (无任何子提交指向它)
      col = findFreeCol();
      color = allocColor();
    }

    // 上半区连线: 已有活跃泳道从顶部进来
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      if (!l) continue;
      if (l.expected === commit.hash) {
        // 匹配当前节点的泳道全部汇入 col
        topLines.push({ from: i, to: col, color: l.color });
      } else {
        // 其余泳道直通到中线
        topLines.push({ from: i, to: i, color: l.color });
      }
    }

    // 释放除主列外的重复匹配泳道
    for (const c of matchingCols) {
      lanes[c] = null;
    }

    // 2. 处理 parents, 生成下半区连线并更新活跃泳道
    const bottomLines: LaneLine[] = [];

    // 先画与当前节点无关的直通泳道
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      if (!l) continue;
      bottomLines.push({ from: i, to: i, color: l.color });
    }

    const parents = commit.parents;
    if (parents.length > 0) {
      // 第一父提交: 仅当已有「更靠左」的泳道在等待 p0 时才向左合流并释放当前列;
      // 若 p0 在右侧支线等待 (existingP0 > col), 主干保持当前 col 笔直向下, 待到达 p0 行时由右侧支线优雅汇入左侧主干
      const p0 = parents[0];
      const existingP0 = lanes.findIndex((l) => l?.expected === p0);
      if (existingP0 >= 0 && existingP0 < col) {
        bottomLines.push({ from: col, to: existingP0, color });
      } else {
        lanes[col] = { expected: p0, color };
        bottomLines.push({ from: col, to: col, color });
      }

      // 其余父提交 (merge commit 的第 2+ 父提交): 若已有泳道等待则连过去, 否则新开一条泳道
      for (let pi = 1; pi < parents.length; pi++) {
        const p = parents[pi];
        const existing = lanes.findIndex((l) => l?.expected === p);
        if (existing >= 0) {
          bottomLines.push({ from: col, to: existing, color: lanes[existing]!.color });
        } else {
          const newCol = findFreeCol();
          const newColor = allocColor();
          lanes[newCol] = { expected: p, color: newColor };
          bottomLines.push({ from: col, to: newCol, color: newColor });
        }
      }
    }

    // 裁剪尾部空泳道, 保持列宽紧凑
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    let rowMaxCol = col;
    for (const line of topLines) {
      if (line.from > rowMaxCol) rowMaxCol = line.from;
      if (line.to > rowMaxCol) rowMaxCol = line.to;
    }
    for (const line of bottomLines) {
      if (line.from > rowMaxCol) rowMaxCol = line.from;
      if (line.to > rowMaxCol) rowMaxCol = line.to;
    }
    const widthCols = rowMaxCol + 1;
    if (widthCols > maxCols) maxCols = widthCols;

    rows.push({
      commit,
      col,
      color,
      isMerge: parents.length > 1,
      topLines,
      bottomLines,
      widthCols,
    });
  }

  return { rows, maxCols };
}
