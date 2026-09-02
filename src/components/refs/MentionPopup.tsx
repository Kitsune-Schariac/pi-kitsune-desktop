// @ 引用候选浮层: 项目文件 (list_files_recursive) + 技能 (list_skills_and_packages) 两源混合
// 键盘路由由 InputBar 统一处理 (↑↓/Enter/Esc), 本组件经 ref 暴露 move/confirm 供其调用
// 选中回调 PathRef, 与「上下文」按钮同构 (chips 渲染/预览/移除全复用)

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, Sparkles, Loader2, AlertCircle, X } from "lucide-react";
import type { PathRef } from "../../lib/refs";

interface FileEntry {
  name: string;
  path: string;
  size: number | null;
  mtime: number | null;
}

interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

/** 扁平候选: file 在前 skill 在后, 组内按匹配分排序 */
export interface MentionCandidate {
  kind: "file" | "skill";
  title: string;
  path: string;
  /** 副标题: 文件=所在目录, 技能=描述 */
  sub: string;
  meta?: { size?: number };
}

export interface MentionPopupHandle {
  move: (delta: number) => void;
  confirm: () => void;
}

/**
 * 匹配分: basename 前缀 4 > basename 子串 3 > 路径段对齐命中 2 > 路径子串 1, 不匹配 -1
 * 排序: 分高在前, 同分名称短者优先 (文件名越短越像用户要找的)
 *
 * 归一化关键: Windows 路径是反斜杠 (C:\...\yfz\index.vue), 用户输入正斜杠 (yfz/index),
 * 分隔符不统一会导致多级路径片段永远匹配不上 —— 两侧统一成小写 + 正斜杠再比对
 */
function score(title: string, path: string, query: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\\/g, "/");
  const q = norm(query);
  const base = norm(title);
  const full = norm(path);
  if (base.startsWith(q)) return 4;
  if (base.includes(q)) return 3;
  // 路径段对齐: query 含多级路径段 (yfz/index) 且整段命中归一化路径 → 优于单段路径子串
  if (q.includes("/") && full.includes(q)) return 2;
  if (full.includes(q)) return 1;
  return -1;
}

export function filterMentionCandidates(files: FileEntry[], skills: SkillInfo[], root: string, query: string): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const out: MentionCandidate[] = [];
  if (q) {
    const fileHits: { c: MentionCandidate; s: number }[] = [];
    for (const f of files) {
      const s = score(f.name, f.path, q);
      if (s >= 0) fileHits.push({ c: { kind: "file", title: f.name, path: f.path, sub: relDir(f.path, root), meta: { size: f.size ?? undefined } }, s });
    }
    // 空查询展示上限 50: 大项目全量渲染会卡; 有查询时按匹配度截断同样上限
    fileHits.sort((a, b) => b.s - a.s || a.c.title.length - b.c.title.length);
    out.push(...fileHits.slice(0, 50).map((h) => h.c));
    const skillHits: { c: MentionCandidate; s: number }[] = [];
    for (const sk of skills) {
      const s = score(sk.name, sk.path, q);
      if (s >= 0) skillHits.push({ c: { kind: "skill", title: sk.name, path: sk.path, sub: sk.description || "skill" }, s });
    }
    skillHits.sort((a, b) => b.s - a.s || a.c.title.length - b.c.title.length);
    out.push(...skillHits.slice(0, 50).map((h) => h.c));
  } else {
    // 空查询: 文件按名称排序取前 50 (扫描输出已按目录序, 这里按名称稳定排序), 技能全量
    const fileSorted = [...files].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    out.push(...fileSorted.slice(0, 50).map((f) => ({ kind: "file" as const, title: f.name, path: f.path, sub: relDir(f.path, root), meta: { size: f.size ?? undefined } })));
    out.push(...skills.slice(0, 50).map((s) => ({ kind: "skill" as const, title: s.name, path: s.path, sub: s.description || "skill" })));
  }
  return out;
}

/** 文件所在目录 (相对 root), 用于候选行副标题; root 前缀不匹配时退化为完整目录 */
function relDir(path: string, root: string): string {
  const dirs = path.split(/[\\/]/);
  dirs.pop();
  const dir = dirs.join("/");
  // root 与扫描 path 的分隔符可能不一致 (\ vs /), 统一成 / 再比前缀;
  // 前缀带尾斜杠边界: 防 root=C:/proj 误匹配 c:/proj2/... (根直属文件退化显示完整路径, 可接受)
  const rootNorm = root.replace(/[\\/]+$/, "").toLowerCase().replace(/\\/g, "/");
  const dirLower = dir.toLowerCase();
  if (dirLower === rootNorm) return ".";
  if (dirLower.startsWith(rootNorm + "/")) {
    return dir.slice(root.length).replace(/^[\\/]+/, "") || ".";
  }
  return dir || ".";
}

/** 文件列表按 root 缓存: cwd 切换失效重扫, 同项目重复打开 @ 不重复扫描大项目 */
let fileCache: { root: string; files: FileEntry[] } | null = null;

export function MentionPopup({ root, query, onPick, onClose, ref }: {
  root: string;
  query: string;
  onPick: (r: PathRef) => void;
  onClose: () => void;
  ref?: React.Ref<MentionPopupHandle>;
}) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // Everything 搜索层: searchResults 有值则作为文件源; searchDegraded 为 true 后不再重试
  // (es 缺失/超时会重复触发 500ms 超时, 降级一次后直接用全量扫描, 避免每次击键都卡)
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchDegraded, setSearchDegraded] = useState(false);
  // 搜索请求竞态保护: 快速连续输入只采纳最后一次响应 (hook-guidelines reqId 模式)
  const searchReqId = useRef(0);

  // 文件源: 无项目 (root 空) 直接空数组 → 前端显示空态; 有缓存且 root 未变则复用
  useEffect(() => {
    if (!root) { setFiles([]); return; }
    if (fileCache && fileCache.root === root) { setFiles(fileCache.files); return; }
    setFiles(null);
    let cancelled = false;
    invoke<FileEntry[]>("list_files_recursive", { root })
      .then((list) => {
        if (cancelled) return;
        fileCache = { root, files: list };
        setFiles(list);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [root]);

  // 技能源: 每次打开拉取 (列表小, 且技能可能新装, 不做缓存)
  useEffect(() => {
    let cancelled = false;
    invoke<{ skills: SkillInfo[] }>("list_skills_and_packages")
      .then((v) => { if (!cancelled) setSkills(v.skills || []); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Everything 搜索源: query 非空时走 search_files (毫秒级), 结果替代全量扫描;
  // 失败静默降级 (不弹错误条) —— 增强层不允许打断 @ 引用主流程
  useEffect(() => {
    const q = query.trim();
    // query/root 变化先清掉上次结果, 防止新 query 搜索返回前误显示旧匹配;
    // 空 query 时递增 reqId 作废在途请求, 避免旧回调污染 state
    searchReqId.current++;
    setSearchResults(null);
    setSearching(false);
    if (!q || searchDegraded) return;
    const id = ++searchReqId.current;
    setSearching(true);
    invoke<FileEntry[]>("search_files", { query: q, root })
      .then((list) => {
        if (searchReqId.current !== id) return;
        setSearchResults(list);
        setSearching(false);
      })
      .catch(() => {
        if (searchReqId.current !== id) return;
        // es 不可用/超时: 记下降级, 后续 query 变更直接走全量 files, 不再重试 es
        setSearchDegraded(true);
        setSearchResults(null);
        setSearching(false);
      });
  }, [query, root, searchDegraded]);

  // 加载态判定: 全量未到且无搜索兜底才 loading; es 挂起/搜索中时若全量已就绪,
  // 直接展示全量过滤结果, 搜索返回后无缝切换 (避免每次击键都闪 spinner)
  const loading = skills === null || (files === null && !(query.trim() && searchResults));
  const candidates = useMemo(
    () => filterMentionCandidates(query.trim() && searchResults ? searchResults : files ?? [], skills ?? [], root, query),
    [files, skills, root, query, searchResults]
  );

  // 过滤词/数据变化后选中索引回到顶部, 避免高亮项落到不可见处
  useEffect(() => { setActive(0); }, [query, files, skills, root]);

  const pick = (c: MentionCandidate) => {
    onPick(c.kind === "file"
      ? { kind: "file", title: c.title, path: c.path, meta: c.meta }
      : { kind: "skill", title: c.title, path: c.path });
  };

  // 键盘路由入口: InputBar 的 onKeyDown 拦截 ↑↓/Enter/Esc 后经此 handle 驱动
  useImperativeHandle(ref, () => ({
    move: (delta: number) => {
      const n = candidates.length;
      if (n > 0) setActive((a) => (a + delta + n) % n);
    },
    confirm: () => {
      const c = candidates[active];
      if (c) pick(c);
    },
  }), [candidates, active, pick]);

  // 分组渲染: 文件在前技能在后 (filterMentionCandidates 已按此序输出), 组间插标题
  const firstSkill = candidates.findIndex((c) => c.kind === "skill");
  const fileCount = firstSkill === -1 ? candidates.length : firstSkill;

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-[460px] rounded-md border border-neutral-200 bg-panel p-2 shadow-lg">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-xs text-neutral-400">引用文件或技能 · ↑↓ 选择, Enter 确认</span>
        <button
          onClick={onClose}
          className="rounded-sm p-1 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-100"
          title="关闭 (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <p className="mx-2 mb-1 flex items-center gap-1 rounded-md bg-red-50 px-2 py-2 text-xs text-red-500">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex h-28 items-center justify-center gap-2 text-xs text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin" /> {searching ? "搜索中…" : "扫描项目文件…"}
        </div>
      ) : (
        <div className="max-h-72 overflow-auto">
          {candidates.length === 0 ? (
            <div className="flex h-28 items-center justify-center text-xs text-neutral-300">
              {!root ? "无项目可扫描, 请先在上方选择项目" : "没有匹配的文件或技能"}
            </div>
          ) : (
            candidates.map((c, i) => {
              const isFile = c.kind === "file";
              const sel = i === active;
              return (
                <div key={c.path}>
                  {(i === 0 || i === firstSkill) && (
                    <div className="px-2 pb-1 pt-2 text-xs font-medium text-neutral-400">
                      {isFile ? `文件 · ${fileCount}` : "技能"}
                    </div>
                  )}
                  <button
                    onClick={() => { setActive(i); pick(c); }}
                    onMouseEnter={() => setActive(i)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition duration-fast ease-out ${
                      sel ? "bg-primary-50" : "hover:bg-neutral-100"
                    }`}
                    title={c.path}
                  >
                    {isFile ? (
                      <FileText className="h-4 w-4 shrink-0 text-neutral-400" />
                    ) : (
                      <Sparkles className="h-4 w-4 shrink-0 text-primary-400" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate font-medium ${sel ? "text-primary-700" : "text-neutral-700"}`}>
                        {c.title}
                      </span>
                      <span className="block truncate text-xs text-neutral-400">{c.sub}</span>
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
