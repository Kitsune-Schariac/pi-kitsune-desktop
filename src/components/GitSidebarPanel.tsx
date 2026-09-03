// Git 侧栏面板: 会话区右侧内嵌面板 (design 三-3.3), 四态视图机承载概览 + 操作 + 深度查看。
// list (分支/变更/暂存/提交/切分支) → 点文件切 diff (工作区文件 diff) →
// history (提交列表) → 点提交切 commit (该提交完整 patch, 多文件)。
// 所有深度交互在面板内完成, 无弹层式 diff (2026-08-25 二次调整: 弹窗打断感仍在, 改原地切换)。
// 视觉上是嵌在会话区内部展开的一块圆角卡片 (非贴边硬分割), 本质仍是 flex 让位的侧栏;
// 左缘拖拽手柄动态调宽, 进入 diff/commit 自动拉宽给 diff 可读空间。
// 写操作 (stage/commit/checkout) 二次确认弹层保留 (PRD R4: 单次误点不触发)。
// Esc 优先级: confirm 弹层 → branchPicker 弹层 → 非 list 视图返回上一级 → list 不响应 (常驻面板)。
// 结构预留多源扩展位 (design 三-3.2), 本次只 git 一个区, 不读 .trellis/ (trellis-task-view 范围)。
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  X, RefreshCw, Loader2, GitBranch, ArrowUp, ArrowDown, FilePen,
  FilePlus2, FileMinus2, ArrowRightLeft, FileQuestion, AlertTriangle, FileText,
  Plus, Minus, Check, GitCommitHorizontal, ChevronLeft, History,
} from "lucide-react";
import { useGitStore } from "../store/git";
import type { GitFileChange, GitChangeType } from "../store/git";
import { DiffView } from "./DiffView";

// 文件类型 → 中文标签 + Lucide 图标。不透传 git 原始字母码 (那是给命令行的), GUI 用语义标签 (design 二-2.2)。
// 原导出给 GitDiffModal 用, S5 删除 GitDiffModal 后收回为模块私有, 单一来源避免两处定义漂移。
const CHANGE_META: Record<GitChangeType, { label: string; Icon: typeof FilePen }> = {
  modified: { label: "修改", Icon: FilePen },
  added: { label: "新增", Icon: FilePlus2 },
  deleted: { label: "删除", Icon: FileMinus2 },
  renamed: { label: "重命名", Icon: ArrowRightLeft },
  untracked: { label: "未跟踪", Icon: FileQuestion },
  conflict: { label: "冲突", Icon: AlertTriangle },
};

// 侧栏四态视图: list 为顶层, diff/history 从 list 进入, commit 从 history 进入。
// diff→list, commit→history, history→list 是 Esc 与‹返回的回退路径。
type View =
  | { kind: "list" }
  | { kind: "diff"; path: string; staged: boolean }
  | { kind: "history" }
  | { kind: "commit"; hash: string };

interface Props {
  cwd?: string;
  onClose: () => void;
}

// 调用侧处理 git 特有的 /dev/null 形态 (design 二·五, 已实测):
// 新增文件 patch 头 `--- /dev/null`、删除文件 `+++ /dev/null`, 直接喂 DiffView 文件头会
// 显示成 "/dev/null → x.txt"。把 /dev/null 行替换为对侧路径 (带 a/ b/ 前缀, DiffView
// 的 relPath 会剥前缀), 让文件头干净 (oldRel === newRel 只显示文件名)。
// 绝不改 DiffView/patch.ts (已交付验证, 改动波及工具卡片)。
// 二进制 diff 无 --- /+++ 行, 此函数原样返回, DiffView 自动降级纯文本展示原文。
//
// 多段安全 (S5 升级): git_show 返回整个提交的多文件 patch, 每个文件段可能各自含 /dev/null
// (一个提交同时新增和删除文件很常见)。旧版只匹配首个 /dev/null (非全局 replace + 匹配首个
// +++ 行), 多文件段会漏处理后续段。以 `diff --git` 行为界切段 (首段可能无此前缀, 如纯
// --- /+++ 格式; split 后首段即前导内容, 对无 --- /+++ 的段无副作用), 逐段做对侧路径替换
// 再拼接, 各段独立处理互不干扰。
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

// git iso 日期 "2026-08-25 14:30:00 +0800" → 截到分 "2026-08-25 14:30" (紧凑, tabular-nums 对齐)
const fmtDate = (d: string) => d.slice(0, 16);
const shortHash = (h: string) => h.slice(0, 7);

// 侧栏宽度: 默认紧凑态; 进入 diff/commit 视图自动拉到 AUTO_DIFF_W 给 patch 可读空间。
// 用户手动拖过后以用户为准, 不再自动拉 (userResizedRef); 双击手柄复位并恢复自动拉宽资格。
const DEFAULT_W = 340;
const AUTO_DIFF_W = 560;
const MIN_W = 300;
const MAX_W = 720;

export function GitSidebarPanel({ cwd, onClose }: Props) {
  const status = useGitStore((s) => (cwd ? s.statusByCwd[cwd] ?? null : null));
  const loading = useGitStore((s) => (cwd ? s.loadingByCwd[cwd] ?? false : false));
  const error = useGitStore((s) => (cwd ? s.errorByCwd[cwd] ?? null : null));
  const branches = useGitStore((s) => s.branches);
  const branchesLoading = useGitStore((s) => s.branchesLoading);
  const writing = useGitStore((s) => s.writing);
  const diff = useGitStore((s) => s.diff);
  const diffLoading = useGitStore((s) => s.diffLoading);
  const diffError = useGitStore((s) => s.diffError);
  const log = useGitStore((s) => s.log);
  const logLoading = useGitStore((s) => s.logLoading);
  const logError = useGitStore((s) => s.logError);
  const show = useGitStore((s) => s.show);
  const showLoading = useGitStore((s) => s.showLoading);
  const loadStatus = useGitStore((s) => s.loadStatus);
  const loadBranches = useGitStore((s) => s.loadBranches);
  const stageFiles = useGitStore((s) => s.stageFiles);
  const unstageFiles = useGitStore((s) => s.unstageFiles);
  const commit = useGitStore((s) => s.commit);
  const checkout = useGitStore((s) => s.checkout);
  const loadDiff = useGitStore((s) => s.loadDiff);
  const clearDiff = useGitStore((s) => s.clearDiff);
  const loadLog = useGitStore((s) => s.loadLog);
  const loadShow = useGitStore((s) => s.loadShow);
  const clearShow = useGitStore((s) => s.clearShow);

  const [view, setView] = useState<View>({ kind: "list" });
  // 面板宽度自治: wrapper 自己持 width, flex 兄弟布局自适应, App 不感知。
  // 拖拽中禁用 width transition duration-fast ease-out 保证跟手; 拖过一次后自动拉宽退位 (以用户为准)
  const [width, setWidth] = useState(DEFAULT_W);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);
  const userResizedRef = useRef(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  // git_show 失败的瞬时错误: store 只管 show/showLoading, error 归视图 local (切 hash 自动清)
  const [showError, setShowError] = useState<string | null>(null);
  // showError 防串台守卫: 快速连点提交 A→B 时, A 迟到的 reject 不得污染 B 视图。
  // store 层 showEpoch 管槽位与 loading, 这层管 re-throw 到组件的错误展示 (check P1)
  const showEpochRef = useRef(0);
  const [confirm, setConfirm] = useState<null | {
    title: string;
    message: string;
    confirmText: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }>(null);

  // cwd 变化 (切项目) 重拉 status + 清提交信息/错误/视图状态。侧栏挂载时也跑一次 (design 四 时机 1)。
  // loadStatus 稳定引用不进依赖; 切项目回 list 避免残留旧仓库的 diff/history/commit 视图
  useEffect(() => {
    if (cwd) loadStatus(cwd);
    setCommitMsg("");
    setActionError(null);
    setView({ kind: "list" });
  }, [cwd]);

  // 视图切换副作用: 进入 diff/history/commit 时拉对应数据。loadDiff/loadLog/loadShow 稳定引用不进依赖
  useEffect(() => {
    if (!cwd) return;
    if (view.kind === "diff") {
      loadDiff(cwd, view.path, view.staged);
    } else if (view.kind === "history") {
      loadLog(cwd);
    } else if (view.kind === "commit") {
      setShowError(null);
      const epoch = ++showEpochRef.current;
      // loadShow 失败不 catch (re-throw), 组件 catch 后 local state 展示 (design: 视图切换纯前端状态)
      loadShow(cwd, view.hash).catch((e) => {
        if (epoch === showEpochRef.current) setShowError(String(e));
      });
    }
  }, [view, cwd]);

  // 离开 diff/commit 视图清掉对应 store 槽位, 避免残留干扰下次进入 (loadDiff/loadShow 不预先清旧值)
  useEffect(() => {
    if (view.kind !== "diff") clearDiff();
    if (view.kind !== "commit") clearShow();
  }, [view]);

  // Esc 优先级: confirm → branchPicker → 非 list 返回上一级 → list 不响应 (常驻面板)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirm) { setConfirm(null); return; }
      if (branchPickerOpen) { setBranchPickerOpen(false); return; }
      if (view.kind === "diff") { setView({ kind: "list" }); return; }
      if (view.kind === "commit") { setView({ kind: "history" }); return; }
      if (view.kind === "history") { setView({ kind: "list" }); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, branchPickerOpen, view]);

  // 进入 diff/commit 自动拉宽 (patch 单列在窄栏里太挤); 返回 list 不缩回, 避免视图往复跳动。
  // 用户手动拖过则以用户为准, 不再干预 (依赖只有 view.kind: width 仅作条件读取, 不参与触发)
  useEffect(() => {
    if (
      (view.kind === "diff" || view.kind === "commit") &&
      !userResizedRef.current &&
      width < AUTO_DIFF_W
    ) {
      setWidth(AUTO_DIFF_W);
    }
  }, [view.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // 左缘拖拽调宽: 向左拖 = 变宽 (面板在右侧)。监听挂 window 保证移出热区仍跟手,
  // mouseup 统一清理; clamp 防止把消息流挤没或拖到不可用宽度
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, w: width };
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const s = dragStartRef.current;
      if (!s) return;
      userResizedRef.current = true;
      setWidth(Math.min(MAX_W, Math.max(MIN_W, s.w - (ev.clientX - s.x))));
    };
    const onUp = () => {
      dragStartRef.current = null;
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 文件分组: 已暂存 / 未暂存 (排除未跟踪) / 未跟踪。
  // 一个文件两侧都有改动时在已暂存和未暂存两组各出现一次, 分别看两侧 diff
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

  // diff 视图: 校验当前 diff 是否匹配 view (防串台, 与原 GitDiffModal 同逻辑)
  const diffMatches =
    !!diff && view.kind === "diff" &&
    diff.cwd === cwd && diff.path === view.path && diff.staged === view.staged;
  const viewPatch = useMemo(
    () => (diff ? normalizePatchHead(diff.patch) : ""),
    [diff],
  );
  // diff 视图类型图标: 从 status 找选中文件对应侧的 type 查 CHANGE_META
  const selectedType = useMemo<GitChangeType | null>(() => {
    if (view.kind !== "diff") return null;
    const f = status?.files.find((x) => x.path === view.path);
    return f ? (view.staged ? f.staged : f.unstaged) : null;
  }, [status, view]);
  const selectedMeta = selectedType ? CHANGE_META[selectedType] : null;
  const SelectedIcon = selectedMeta?.Icon;

  // commit 视图: 校验 show 是否匹配当前 hash (防串台, 同 diff 逻辑)
  const showMatches = view.kind === "commit" && !!show && show.hash === view.hash;
  const showPatch = useMemo(
    () => (show ? normalizePatchHead(show.patch) : ""),
    [show],
  );

  // --- 写操作: 失败 setActionError 红字, 不吞错误 (spec: 面板级错误显示在面板内) ---

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

  // 提交: 二次确认 (PRD R4, 写操作不可轻易回退, 单次误点不能触发)
  const askCommit = () => {
    const msg = commitMsg.trim();
    if (!cwd || !msg || !hasStaged || writing) return;
    setConfirm({
      title: "确认提交",
      message: `将提交 ${groups.staged.length} 个暂存文件, 提交信息:\n\n${msg}`,
      confirmText: "提交",
      onConfirm: async () => {
        setConfirm(null);
        try {
          await commit(cwd, msg);
          setCommitMsg("");
          setActionError(null);
        } catch (e) {
          // pre-commit hook 拒绝等: stderr 原样上抛 (run_git 不截断), 用户需看到原因
          setActionError(`提交失败: ${String(e)}`);
        }
      },
      onCancel: () => setConfirm(null),
    });
  };

  // 切分支: 脏工作区必须明确提示后果 (PRD R3), 不静默执行; 干净工作区也走二次确认防误点
  const askCheckout = (branch: string) => {
    if (!cwd || writing) return;
    setBranchPickerOpen(false);
    const dirtyCount = (status?.files ?? []).length;
    setConfirm({
      title: "切换分支",
      message: dirtyCount > 0
        ? `工作区有 ${dirtyCount} 个未提交改动, 切换到「${branch}」可能导致冲突或丢失未提交的修改。确定切换?`
        : `切换到分支「${branch}」?`,
      confirmText: "切换",
      danger: dirtyCount > 0,
      onConfirm: async () => {
        setConfirm(null);
        try {
          await checkout(cwd, branch);
          setActionError(null);
        } catch (e) {
          // git 因脏工作区拒绝 checkout 时 stderr 会说明哪些文件阻挡, 原样展示
          setActionError(`切换分支失败: ${String(e)}`);
        }
      },
      onCancel: () => setConfirm(null),
    });
  };

  return (
    <>
      {/* 外壳: 持有宽度与四周留白, 让面板本体成为嵌在会话区内部展开的圆角卡片 (内联视觉,
          非贴边硬分割); 布局本质仍是 #app-root flex 行里让位的侧栏兄弟节点 */}
      <div
        className="relative flex h-full shrink-0 flex-col py-2 pr-2"
        style={{ width, transition: dragging ? "none" : "width 160ms ease-out" }}
      >
        {/* 拖拽手柄: 左缘窄热区; 悬停/拖拽中亮出指示条, 双击复位默认宽 */}
        <div
          onMouseDown={startResize}
          onDoubleClick={() => { userResizedRef.current = false; setWidth(DEFAULT_W); }}
          className="group absolute bottom-2 left-0 top-2 z-10 flex w-2 cursor-col-resize items-center justify-center"
          title="拖动调整宽度 · 双击复位"
        >
          <div
            className={`h-10 w-[3px] rounded-full transition duration-fast ease-out ${
              dragging ? "bg-[var(--primary-500)]" : "bg-transparent group-hover:bg-[var(--border-strong)]"
            }`}
          />
        </div>
        <aside className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-base)_calc(var(--chat-alpha)_*_100%),transparent)] shadow-sm">
        {view.kind === "list" ? (
          // list header: 分支(可点击切换) + upstream/ahead/behind + 历史 + 刷新 + 收起
          <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch className="h-4 w-4 shrink-0 text-neutral-500" />
              {status?.is_repo && status.branch ? (
                <button
                  onClick={() => {
                    if (!cwd || writing) return;
                    loadBranches(cwd);
                    setBranchPickerOpen(true);
                  }}
                  className="truncate text-sm font-medium transition duration-fast ease-out hover:text-[var(--primary-600)]"
                  title="切换分支"
                >
                  {status.branch}
                </button>
              ) : (
                <span className="text-sm text-neutral-400">—</span>
              )}
              {status?.upstream && (
                <span className="truncate text-xs text-neutral-400" title={`追踪 ${status.upstream}`}>
                  · {status.upstream}
                </span>
              )}
              {!!status?.ahead && (
                <span className="flex items-center text-xs text-neutral-500" title={`领先 ${status.ahead} 个提交`}>
                  <ArrowUp className="h-3 w-3" />
                  {status.ahead}
                </span>
              )}
              {!!status?.behind && (
                <span className="flex items-center text-xs text-neutral-500" title={`落后 ${status.behind} 个提交`}>
                  <ArrowDown className="h-3 w-3" />
                  {status.behind}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => setView({ kind: "history" })}
                disabled={!status?.is_repo || writing}
                className="rounded-md p-1 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-700 disabled:opacity-40"
                title="提交历史"
              >
                <History className="h-4 w-4" />
              </button>
              <button
                onClick={() => cwd && loadStatus(cwd)}
                disabled={!cwd || loading}
                className="rounded-md p-1 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-700 disabled:opacity-40"
                title="刷新"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={onClose}
                className="rounded-md p-1 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-700"
                title="收起"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : view.kind === "diff" ? (
          // diff 视图导航条: ‹ 返回 + 类型标签 + 文件路径 + staged 标记
          <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2">
            <button
              onClick={() => setView({ kind: "list" })}
              className="flex items-center rounded-md p-1 text-neutral-500 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-800"
              title="返回 (Esc)"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex min-w-0 items-center gap-2">
              {selectedMeta && SelectedIcon && (
                <span className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
                  <SelectedIcon className="h-4 w-4" />
                  {selectedMeta.label}
                </span>
              )}
              <span className="truncate font-mono text-xs text-neutral-600" title={view.path}>
                {view.path}
              </span>
              {view.staged && <span className="shrink-0 text-xs text-neutral-400">· 已暂存</span>}
            </div>
          </div>
        ) : view.kind === "history" ? (
          // history 视图导航条: ‹ 返回 + 标题
          <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2">
            <button
              onClick={() => setView({ kind: "list" })}
              className="flex items-center rounded-md p-1 text-neutral-500 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-800"
              title="返回 (Esc)"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium">提交历史</span>
          </div>
        ) : (
          // commit 视图导航条: ‹ 返回(回 history) + subject + 短 hash + 次行 author·date
          <div className="border-b border-neutral-200">
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                onClick={() => setView({ kind: "history" })}
                className="flex items-center rounded-md p-1 text-neutral-500 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-800"
                title="返回 (Esc)"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-sm font-medium" title={showMatches ? show?.subject : ""}>
                  {showMatches ? show?.subject : "加载中…"}
                </span>
                <span className="shrink-0 font-mono text-xs text-neutral-400">{shortHash(view.hash)}</span>
              </div>
            </div>
            {showMatches && show && (
              <div className="flex items-center gap-2 px-3 pb-2 text-xs text-neutral-400">
                <span className="truncate">{show.author}</span>
                <span>·</span>
                <span className="tabular-nums">{fmtDate(show.date)}</span>
              </div>
            )}
          </div>
        )}

        {/* 暂存/取消暂存全部 toolbar (仅 list 视图 + 仓库有变更时) */}
        {view.kind === "list" && status?.is_repo && (hasStaged || hasUnstaged) && (
          <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2">
            <button
              onClick={() => handleStage(allUnstagedPaths)}
              disabled={writing || !hasUnstaged}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-500 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-800 disabled:opacity-40"
              title="暂存所有未暂存与未跟踪文件"
            >
              <Plus className="h-3 w-3" />
              全部暂存
            </button>
            <button
              onClick={() => handleUnstage(allStagedPaths)}
              disabled={writing || !hasStaged}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-500 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-800 disabled:opacity-40"
              title="取消所有暂存"
            >
              <Minus className="h-3 w-3" />
              全部取消暂存
            </button>
          </div>
        )}

        {/* 内容区: flex-1 overflow-y-auto, 按 view.kind 渲染对应内容 */}
        <div className="flex-1 overflow-y-auto">
          {view.kind === "list" ? (
            // list: 降级优先 (无 cwd / 加载 / 错误 / 非仓库 / 干净) + 文件分组
            !cwd ? (
              <Hint text="请先打开一个项目会话" />
            ) : loading && !status ? (
              <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="加载中…" />
            ) : error ? (
              <p className="px-4 py-6 text-sm text-red-500">{error}</p>
            ) : !status?.is_repo ? (
              <Hint text="非 Git 仓库" />
            ) : status.files.length === 0 ? (
              <Hint text="工作区干净" />
            ) : (
              <>
                <FileGroup
                  title="已暂存"
                  items={groups.staged}
                  side="staged"
                  onSelect={(s) => setView({ kind: "diff", path: s.path, staged: s.staged })}
                  writing={writing}
                  onUnstageFile={(p) => handleUnstage([p])}
                />
                <FileGroup
                  title="未暂存"
                  items={groups.unstaged}
                  side="unstaged"
                  onSelect={(s) => setView({ kind: "diff", path: s.path, staged: s.staged })}
                  writing={writing}
                  onStageFile={(p) => handleStage([p])}
                />
                <FileGroup
                  title="未跟踪"
                  items={groups.untracked}
                  side="unstaged"
                  onSelect={(s) => setView({ kind: "diff", path: s.path, staged: s.staged })}
                  writing={writing}
                  onStageFile={(p) => handleStage([p])}
                />
              </>
            )
          ) : view.kind === "diff" ? (
            // diff: 错误 / 加载中 / 渲染 / 兜底四态 (与原 GitDiffModal 同)
            diffError ? (
              <p className="px-4 py-6 text-sm text-red-500">{diffError}</p>
            ) : diffLoading && !diffMatches ? (
              <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="加载中…" />
            ) : diffMatches ? (
              <div className="p-3">
                <DiffView patch={viewPatch} cwd={cwd} />
              </div>
            ) : (
              <Hint text="加载中…" />
            )
          ) : view.kind === "history" ? (
            // history: 错误 / 加载 / 空态 / 列表
            logError ? (
              <p className="px-4 py-6 text-sm text-red-500">{logError}</p>
            ) : logLoading && !log ? (
              <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="加载中…" />
            ) : !log?.length ? (
              <Hint text="无提交记录" />
            ) : (
              log.map((e) => (
                <button
                  key={e.hash}
                  onClick={() => setView({ kind: "commit", hash: e.hash })}
                  className="flex w-full flex-col gap-1 border-b border-neutral-100 px-4 py-2 text-left transition duration-fast ease-out hover:bg-neutral-200/60"
                >
                  <span className="truncate text-xs font-medium text-neutral-800" title={e.subject}>
                    {e.subject}
                  </span>
                  <div className="flex items-center gap-2 text-xs text-neutral-400">
                    <span className="truncate">{e.author}</span>
                    <span>·</span>
                    <span className="tabular-nums">{fmtDate(e.date)}</span>
                    <span className="ml-auto shrink-0 font-mono">{shortHash(e.hash)}</span>
                  </div>
                </button>
              ))
            )
          ) : (
            // commit: 错误 / 加载 / 渲染 / 兜底 (show 与当前 hash 不匹配时显示加载中)
            showError ? (
              <p className="px-4 py-6 text-sm text-red-500">{showError}</p>
            ) : showLoading && !showMatches ? (
              <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="加载中…" />
            ) : showMatches && show ? (
              <div className="p-3">
                <DiffView patch={showPatch} cwd={cwd} />
              </div>
            ) : (
              <Hint text="加载中…" />
            )
          )}
        </div>

        {/* 提交区: 仅 list 视图 + 仓库有效时显示; 无暂存文件则禁用并提示 */}
        {view.kind === "list" && status?.is_repo && (
          <div className="border-t border-neutral-200 p-3">
            {actionError && <p className="mb-2 text-xs text-red-500">{actionError}</p>}
            <textarea
              value={commitMsg}
              onChange={(e) => { setCommitMsg(e.target.value); setActionError(null); }}
              placeholder="提交信息…"
              rows={2}
              disabled={!hasStaged || writing}
              className="w-full resize-none rounded-md border border-neutral-200 bg-[var(--surface-base)] px-2 py-2 text-xs text-neutral-800 placeholder:text-neutral-400 focus:border-[var(--primary-400)] focus:outline-none disabled:opacity-50"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={askCommit}
                disabled={!hasStaged || !commitMsg.trim() || writing}
                className="flex items-center gap-1 rounded-md bg-[var(--primary-500)] px-3 py-2 text-xs font-medium text-white transition duration-fast ease-out hover:bg-[var(--primary-600)] disabled:opacity-40"
              >
                <GitCommitHorizontal className="h-4 w-4" />
                提交 ({groups.staged.length})
              </button>
              {!hasStaged && <span className="text-xs text-neutral-400">无暂存改动</span>}
            </div>
          </div>
        )}
        </aside>
      </div>

      {/* 分支选择弹层 (list 视图分支按钮触发) */}
      {branchPickerOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBranchPickerOpen(false);
          }}
        >
          <div className="w-72 overflow-hidden rounded-md border border-neutral-200 bg-panel shadow-lg">
            <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
              <span className="text-sm font-medium">切换分支</span>
              <button
                onClick={() => setBranchPickerOpen(false)}
                className="rounded-md p-1 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-200/70 hover:text-neutral-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {branchesLoading ? (
                <Hint icon={<Loader2 className="h-4 w-4 animate-spin" />} text="加载中…" />
              ) : !branches?.length ? (
                <Hint text="无分支或加载失败" />
              ) : (
                branches.map((b) => (
                  <button
                    key={b.name}
                    onClick={() => askCheckout(b.name)}
                    disabled={b.current || writing}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs transition duration-fast ease-out hover:bg-neutral-200/60 disabled:opacity-50"
                  >
                    {b.current ? (
                      <Check className="h-4 w-4 shrink-0 text-[var(--primary-500)]" />
                    ) : (
                      <span className="h-4 w-4 shrink-0" />
                    )}
                    <span className="truncate font-mono">{b.name}</span>
                    {b.upstream && (
                      <span className="truncate text-neutral-400" title={`追踪 ${b.upstream}`}>
                        · {b.upstream}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 二次确认弹层 (提交 / 切分支共用) */}
      {confirm && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) confirm.onCancel();
          }}
        >
          <div className="w-96 overflow-hidden rounded-md border border-neutral-200 bg-panel shadow-lg">
            <div className="border-b border-neutral-200 px-4 py-3 text-sm font-medium">{confirm.title}</div>
            <div className="whitespace-pre-line px-4 py-4 text-xs text-neutral-600">{confirm.message}</div>
            <div className="flex justify-end gap-2 border-t border-neutral-200 px-4 py-3">
              <button
                onClick={confirm.onCancel}
                className="rounded-md px-3 py-2 text-xs text-neutral-500 transition duration-fast ease-out hover:bg-neutral-200/70"
              >
                取消
              </button>
              <button
                onClick={confirm.onConfirm}
                disabled={writing}
                className={`rounded-md px-3 py-2 text-xs font-medium text-white transition duration-fast ease-out disabled:opacity-40 ${
                  confirm.danger ? "bg-red-500 hover:bg-red-600" : "bg-[var(--primary-500)] hover:bg-[var(--primary-600)]"
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

// 文件分组列表。side 决定点击后看哪侧 diff (staged 组 → 已暂存侧, unstaged 组 → 未暂存侧),
// 也决定取文件的 staged 还是 unstaged 字段作类型图标, 以及单文件操作按钮是暂存还是取消暂存。
// 点文件切侧栏内 diff 视图 (不再通知父组件), 故无 selected 高亮 —— 切走即离开 list, 高亮无意义。
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
      <div className="px-4 py-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
        {title} ({items.length})
      </div>
      {items.map((f) => {
        const type = side === "staged" ? f.staged : f.unstaged;
        const meta = type ? CHANGE_META[type] : null;
        const Icon = meta?.Icon ?? FileText;
        return (
          <div key={f.path} className="group flex items-center transition duration-fast ease-out hover:bg-neutral-200/60">
            <button
              onClick={() => onSelect({ path: f.path, staged: isStaged })}
              className="flex flex-1 items-center gap-2 px-4 py-2 text-left text-xs text-neutral-600 transition duration-fast ease-out hover:text-neutral-900"
              title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
            >
              <Icon className="h-4 w-4 shrink-0 text-neutral-400" />
              <span className="truncate font-mono">{f.path}</span>
            </button>
            {fileAction && (
              <button
                onClick={() => fileAction(f.path)}
                disabled={writing}
                className="mr-2 shrink-0 rounded-sm p-1 text-neutral-400 opacity-0 transition duration-fast ease-out hover:text-neutral-700 group-hover:opacity-100 disabled:opacity-40"
                title={actionLabel}
              >
                <ActionIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// 列表空态与加载提示, 复用于多分支降级路径
function Hint({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-neutral-400">
      {icon}
      {text}
    </div>
  );
}