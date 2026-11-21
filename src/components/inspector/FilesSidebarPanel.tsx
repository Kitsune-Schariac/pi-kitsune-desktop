import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp,
  ExternalLink, Eye, EyeOff, File, FileCode2, FileJson, FileText, Folder,
  FolderOpen, FolderSearch, Image, Loader2, Maximize2, RefreshCw, Search, X,
} from "lucide-react";
import { useGitStore, type GitChangeType } from "../../store/git";
import { useThemeStore } from "../../store/theme";
import { useUiStore } from "../../store/ui";
import { highlightLines, langFromFilename } from "../../lib/highlighter";
import { openWithSystem, revealPath } from "../../lib/localPath";
import { CopyButton, EmptyHint } from "../ui";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  mtime: number | null;
}

interface TextFile {
  content: string;
  size: number;
  truncated: boolean;
  encoding: string;
}

interface ResolvedPath {
  path: string;
  kind: "text" | "file" | "dir";
  line: number | null;
}

type FilesView =
  | { kind: "tree" }
  | { kind: "preview"; path: string; relPath: string };

const HIDDEN_DIRS = new Set([
  "node_modules", ".git", "dist", "target", ".next", ".turbo",
  "build", ".cache", "__pycache__", ".venv", "venv", ".idea", ".vscode",
]);

const HL_MAX_LINES = 3000;
const HL_MAX_CHARS = 300_000;
const SEARCH_RENDER_LIMIT = 200;

const CODE_EXTS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java",
  "kt", "swift", "c", "h", "cpp", "cc", "hpp", "cs", "php", "rb", "vue", "svelte",
  "html", "css", "scss", "less", "sql", "sh", "bash", "ps1", "bat", "cmd", "lua",
  "dart", "graphql", "dockerfile", "makefile",
]);
const DATA_EXTS = new Set(["json", "jsonc", "yaml", "yml", "toml", "xml", "ini", "env", "lock"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

function fileIconFor(name: string) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : lower;
  if (IMAGE_EXTS.has(ext)) return Image;
  if (DATA_EXTS.has(ext)) return FileJson;
  if (CODE_EXTS.has(ext) || lower === "dockerfile" || lower === "makefile") return FileCode2;
  if (ext === "md" || ext === "txt" || ext === "log" || ext === "csv") return FileText;
  return File;
}

function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

function toRelPath(absPath: string, root: string): string {
  const a = normalizeSep(absPath);
  const r = normalizeSep(root).replace(/\/+$/, "");
  if (a.toLowerCase().startsWith(r.toLowerCase() + "/")) {
    return a.slice(r.length + 1);
  }
  return a;
}

function formatSize(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const GIT_BADGE: Record<GitChangeType, { code: string; cls: string; label: string }> = {
  modified: { code: "M", cls: "text-warn", label: "已修改" },
  added: { code: "A", cls: "text-ok", label: "新增" },
  untracked: { code: "U", cls: "text-ok", label: "未跟踪" },
  deleted: { code: "D", cls: "text-err", label: "已删除" },
  renamed: { code: "R", cls: "text-warn", label: "重命名" },
  conflict: { code: "!", cls: "text-err", label: "冲突" },
};

const GIT_PRIORITY: Record<GitChangeType, number> = {
  conflict: 6,
  modified: 5,
  added: 4,
  renamed: 3,
  untracked: 2,
  deleted: 1,
};

/**
 * 检查器「文件」页签: 工作目录懒加载树 + 模糊快搜 + Git 状态联动 + Shiki 内联语法高亮预览。
 */
export function FilesSidebarPanel({ cwd }: { cwd?: string }) {
  const [view, setView] = useState<FilesView>({ kind: "tree" });
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  const [childrenMap, setChildrenMap] = useState<Record<string, DirEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [treeError, setTreeError] = useState<string | null>(null);

  // 模糊搜索懒加载全量文件列表 (切项目或点刷新清空)
  const [allFiles, setAllFiles] = useState<DirEntry[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const epochRef = useRef(0);
  const viewerOpen = useUiStore((s) => s.viewer !== null);
  const gitStatus = useGitStore((s) => (cwd ? s.statusByCwd[cwd] ?? null : null));

  // Git 变更状态 → 文件相对路径映射 + 含脏文件的父目录集合
  const { fileGitMap, dirtyDirs } = useMemo(() => {
    const fMap = new Map<string, GitChangeType>();
    const dSet = new Set<string>();
    for (const f of gitStatus?.files ?? []) {
      const rel = normalizeSep(f.path);
      const candidates = [f.unstaged, f.staged].filter(Boolean) as GitChangeType[];
      for (const c of candidates) {
        const prev = fMap.get(rel);
        if (!prev || GIT_PRIORITY[c] > GIT_PRIORITY[prev]) {
          fMap.set(rel, c);
        }
      }
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) {
        dSet.add(parts.slice(0, i).join("/"));
      }
    }
    return { fileGitMap: fMap, dirtyDirs: dSet };
  }, [gitStatus]);

  const loadDir = useCallback(
    async (dirPath: string) => {
      if (!cwd) return;
      const epoch = epochRef.current;
      setLoadingDirs((prev) => new Set(prev).add(dirPath));
      try {
        const list = await invoke<DirEntry[]>("list_dir", { root: cwd, path: dirPath });
        if (epoch !== epochRef.current) return;
        setChildrenMap((prev) => ({ ...prev, [dirPath]: list }));
        setTreeError(null);
      } catch (e) {
        if (epoch !== epochRef.current) return;
        setTreeError(String(e));
      } finally {
        if (epoch === epochRef.current) {
          setLoadingDirs((prev) => {
            const next = new Set(prev);
            next.delete(dirPath);
            return next;
          });
        }
      }
    },
    [cwd],
  );

  // 切项目重置全部状态并拉取根目录
  useEffect(() => {
    epochRef.current += 1;
    setView({ kind: "tree" });
    setQuery("");
    setOpenDirs(new Set());
    setChildrenMap({});
    setLoadingDirs(new Set());
    setTreeError(null);
    setAllFiles(null);
    setSearchError(null);
    if (cwd) {
      void loadDir(cwd);
    }
  }, [cwd, loadDir]);

  // 输入搜索词时懒加载递归文件列表
  const trimmedQuery = query.trim().toLowerCase();
  useEffect(() => {
    if (!cwd || !trimmedQuery || allFiles !== null || searchLoading) return;
    const epoch = epochRef.current;
    setSearchLoading(true);
    setSearchError(null);
    invoke<DirEntry[]>("list_files_recursive", { root: cwd })
      .then((files) => {
        if (epoch !== epochRef.current) return;
        setAllFiles(files);
      })
      .catch((e) => {
        if (epoch !== epochRef.current) return;
        setSearchError(String(e));
      })
      .finally(() => {
        if (epoch === epochRef.current) setSearchLoading(false);
      });
  }, [cwd, trimmedQuery, allFiles, searchLoading]);

  // Esc 返回文件树 (当顶层 FileViewer 弹窗开着时不抢占 Esc)
  useEffect(() => {
    if (view.kind !== "preview" || viewerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView({ kind: "tree" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.kind, viewerOpen]);

  const handleToggleDir = (dirPath: string) => {
    const isOpen = openDirs.has(dirPath);
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
    if (!isOpen && !childrenMap[dirPath]) {
      void loadDir(dirPath);
    }
  };

  const handleRefresh = () => {
    if (!cwd) return;
    epochRef.current += 1;
    setChildrenMap({});
    setAllFiles(null);
    setSearchError(null);
    const dirsToReload = [cwd, ...openDirs];
    for (const d of dirsToReload) {
      void loadDir(d);
    }
  };

  const handleOpenFile = (entry: DirEntry) => {
    if (!cwd) return;
    setView({ kind: "preview", path: entry.path, relPath: toRelPath(entry.path, cwd) });
  };

  const searchResults = useMemo(() => {
    if (!trimmedQuery || !allFiles || !cwd) return [];
    const matched: { entry: DirEntry; rel: string }[] = [];
    for (const f of allFiles) {
      const rel = toRelPath(f.path, cwd);
      if (rel.toLowerCase().includes(trimmedQuery)) {
        matched.push({ entry: f, rel });
      }
    }
    return matched;
  }, [trimmedQuery, allFiles, cwd]);

  if (!cwd) {
    return (
      <div className="p-4">
        <EmptyHint icon={<FolderOpen className="h-5 w-5" />} title="暂无工作目录">
          请先打开一个项目会话以浏览文件
        </EmptyHint>
      </div>
    );
  }

  if (view.kind === "preview") {
    return (
      <InlineFilePreview
        cwd={cwd}
        path={view.path}
        relPath={view.relPath}
        onBack={() => setView({ kind: "tree" })}
      />
    );
  }

  const rootEntries = childrenMap[cwd];
  const rootLoading = loadingDirs.has(cwd) && !rootEntries;

  return (
    <>
      {/* 顶部搜索与操作工具条 */}
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 h-3 w-3 text-fg-4" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索工作区文件…"
            className="h-7 w-full rounded-md border border-line bg-well pl-7 pr-6 text-label text-fg placeholder:text-fg-4 focus:border-line-2 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1 grid h-5 w-5 place-items-center rounded-sm text-fg-4 transition-colors duration-fast ease-out hover:text-fg"
              title="清空搜索"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpenDirs(new Set())}
          disabled={openDirs.size === 0 || !!trimmedQuery}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg disabled:opacity-40"
          title="折叠全部目录"
        >
          <ChevronsDownUp className="h-[14px] w-[14px]" />
        </button>
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors duration-fast ease-out hover:bg-hover ${
            showHidden ? "text-fg" : "text-fg-3 hover:text-fg"
          }`}
          title={showHidden ? "已显示忽略目录 (点击隐藏)" : "显示 node_modules / .git 等忽略目录"}
        >
          {showHidden ? <Eye className="h-[14px] w-[14px]" /> : <EyeOff className="h-[14px] w-[14px]" />}
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loadingDirs.size > 0}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg disabled:opacity-40"
          title="刷新目录"
        >
          <RefreshCw className={`h-[14px] w-[14px] ${loadingDirs.size > 0 ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* 内容区: 模糊搜索列表 或 树形浏览 */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {trimmedQuery ? (
          searchError ? (
            <p className="px-4 py-6 text-body text-err">{searchError}</p>
          ) : searchLoading && !allFiles ? (
            <div className="flex items-center justify-center gap-2 py-10 text-label text-fg-3">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              索引工作区文件…
            </div>
          ) : searchResults.length === 0 ? (
            <div className="p-4">
              <EmptyHint icon={<Search className="h-4 w-4" />} title="未找到匹配文件">
                换一个文件名或路径关键字试试
              </EmptyHint>
            </div>
          ) : (
            <>
              <div className="px-3 py-1 text-meta tabular-nums text-fg-4">
                匹配 {searchResults.length} 个文件
                {searchResults.length > SEARCH_RENDER_LIMIT && ` (展示前 ${SEARCH_RENDER_LIMIT} 项)`}
              </div>
              {searchResults.slice(0, SEARCH_RENDER_LIMIT).map(({ entry, rel }) => {
                const Icon = fileIconFor(entry.name);
                const git = fileGitMap.get(rel);
                const dirPart = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
                return (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => handleOpenFile(entry)}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left transition-colors duration-fast ease-out hover:bg-hover"
                    title={rel}
                  >
                    <Icon className="h-[14px] w-[14px] shrink-0 text-fg-3" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono text-label text-fg">{entry.name}</span>
                      {dirPart && (
                        <span className="ml-2 font-mono text-meta text-fg-4">{dirPart}</span>
                      )}
                    </span>
                    {git && (
                      <span
                        className={`shrink-0 font-mono text-meta font-semibold ${GIT_BADGE[git].cls}`}
                        title={GIT_BADGE[git].label}
                      >
                        {GIT_BADGE[git].code}
                      </span>
                    )}
                  </button>
                );
              })}
            </>
          )
        ) : treeError ? (
          <p className="px-4 py-6 text-body text-err">{treeError}</p>
        ) : rootLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-label text-fg-3">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            读取目录…
          </div>
        ) : !rootEntries || rootEntries.length === 0 ? (
          <div className="p-4">
            <EmptyHint icon={<Folder className="h-4 w-4" />} title="目录为空" />
          </div>
        ) : (
          rootEntries
            .filter((e) => showHidden || !(e.is_dir && HIDDEN_DIRS.has(e.name)))
            .map((entry) => (
              <TreeRow
                key={entry.path}
                entry={entry}
                root={cwd}
                depth={0}
                showHidden={showHidden}
                openDirs={openDirs}
                childrenMap={childrenMap}
                loadingDirs={loadingDirs}
                fileGitMap={fileGitMap}
                dirtyDirs={dirtyDirs}
                onToggleDir={handleToggleDir}
                onOpenFile={handleOpenFile}
              />
            ))
        )}
      </div>
    </>
  );
}

function TreeRow({
  entry,
  root,
  depth,
  showHidden,
  openDirs,
  childrenMap,
  loadingDirs,
  fileGitMap,
  dirtyDirs,
  onToggleDir,
  onOpenFile,
}: {
  entry: DirEntry;
  root: string;
  depth: number;
  showHidden: boolean;
  openDirs: Set<string>;
  childrenMap: Record<string, DirEntry[]>;
  loadingDirs: Set<string>;
  fileGitMap: Map<string, GitChangeType>;
  dirtyDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (entry: DirEntry) => void;
}) {
  const rel = toRelPath(entry.path, root);
  const padLeft = depth * 12 + 8;

  if (!entry.is_dir) {
    const Icon = fileIconFor(entry.name);
    const git = fileGitMap.get(rel);
    return (
      <button
        type="button"
        onClick={() => onOpenFile(entry)}
        className="group flex w-full items-center gap-2 pr-3 py-1 text-left transition-colors duration-fast ease-out hover:bg-hover"
        style={{ paddingLeft: padLeft + 16 }}
        title={rel}
      >
        <Icon className="h-[14px] w-[14px] shrink-0 text-fg-3" />
        <span className="min-w-0 flex-1 truncate font-mono text-label text-fg-2 group-hover:text-fg">
          {entry.name}
        </span>
        {entry.size != null && !git && (
          <span className="shrink-0 font-mono text-meta tabular-nums text-fg-4 opacity-0 transition-opacity duration-fast ease-out group-hover:opacity-100">
            {formatSize(entry.size)}
          </span>
        )}
        {git && (
          <span
            className={`shrink-0 font-mono text-meta font-semibold ${GIT_BADGE[git].cls}`}
            title={GIT_BADGE[git].label}
          >
            {GIT_BADGE[git].code}
          </span>
        )}
      </button>
    );
  }

  const isOpen = openDirs.has(entry.path);
  const kids = childrenMap[entry.path];
  const isLoading = loadingDirs.has(entry.path);
  const isDirty = dirtyDirs.has(rel);
  const isIgnored = HIDDEN_DIRS.has(entry.name);

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleDir(entry.path)}
        className="flex w-full items-center gap-1 pr-3 py-1 text-left transition-colors duration-fast ease-out hover:bg-hover"
        style={{ paddingLeft: padLeft }}
        title={rel}
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-fg-4" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-fg-4" />
        )}
        {isOpen ? (
          <FolderOpen className="h-[14px] w-[14px] shrink-0 text-fg-3" />
        ) : (
          <Folder className="h-[14px] w-[14px] shrink-0 text-fg-3" />
        )}
        <span
          className={`min-w-0 flex-1 truncate font-mono text-label ${
            isIgnored ? "text-fg-4" : "font-medium text-fg-2"
          }`}
        >
          {entry.name}
        </span>
        {isLoading && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-fg-4" />}
        {!isLoading && isDirty && (
          <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-warn" title="包含未提交变更" />
        )}
      </button>
      {isOpen && kids && (
        <div>
          {kids
            .filter((k) => showHidden || !(k.is_dir && HIDDEN_DIRS.has(k.name)))
            .map((k) => (
              <TreeRow
                key={k.path}
                entry={k}
                root={root}
                depth={depth + 1}
                showHidden={showHidden}
                openDirs={openDirs}
                childrenMap={childrenMap}
                loadingDirs={loadingDirs}
                fileGitMap={fileGitMap}
                dirtyDirs={dirtyDirs}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))}
        </div>
      )}
    </div>
  );
}

/** 面板内联语法高亮预览 (Shiki 4.4.2 + 行号 + 一键放大到 FileViewer 弹窗) */
function InlineFilePreview({
  cwd,
  path,
  relPath,
  onBack,
}: {
  cwd: string;
  path: string;
  relPath: string;
  onBack: () => void;
}) {
  const base = useThemeStore((s) => s.resolved);
  const openViewer = useUiStore((s) => s.openViewer);
  const [kind, setKind] = useState<"loading" | "text" | "binary" | "error">("loading");
  const [file, setFile] = useState<TextFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setKind("loading");
    setFile(null);
    setError(null);
    invoke<ResolvedPath>("resolve_local_path", { raw: path, cwd })
      .then(async (res) => {
        if (!alive) return;
        if (res.kind !== "text") {
          setKind("binary");
          return;
        }
        const txt = await invoke<TextFile>("read_text_file", { path: res.path });
        if (!alive) return;
        setFile(txt);
        setKind("text");
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setKind("error");
      });
    return () => {
      alive = false;
    };
  }, [path, cwd]);

  const name = relPath.split("/").pop() || path;
  const lang = useMemo(() => langFromFilename(path), [path]);
  const text = useMemo(
    () => (file ? file.content.replace(/\r\n?/g, "\n").replace(/\n$/, "") : ""),
    [file],
  );
  const lines = useMemo(() => (file ? text.split("\n") : []), [file, text]);
  const html = useMemo(() => {
    if (!lang || lines.length > HL_MAX_LINES || text.length > HL_MAX_CHARS) return null;
    return highlightLines(text, lang);
  }, [lang, text, lines.length, base]);

  const iconBtn =
    "grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部面包屑与快捷操作 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-2">
        <button type="button" onClick={onBack} className={iconBtn} title="返回文件树 (Esc)">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate font-mono text-label font-medium text-fg" title={relPath}>
            {name}
          </div>
          <div className="truncate font-mono text-meta text-fg-4" title={relPath}>
            {relPath}
          </div>
        </div>
        {kind === "text" && (
          <button
            type="button"
            onClick={() => openViewer(path, null)}
            className={iconBtn}
            title="放大到独立查看窗口"
          >
            <Maximize2 className="h-[14px] w-[14px]" />
          </button>
        )}
        <CopyButton text={path} title="复制路径" className="h-7 w-7" />
        <button
          type="button"
          onClick={() => void openWithSystem(path)}
          className={iconBtn}
          title="用系统默认程序打开"
        >
          <ExternalLink className="h-[14px] w-[14px]" />
        </button>
        <button
          type="button"
          onClick={() => void revealPath(path)}
          className={iconBtn}
          title="在资源管理器中定位"
        >
          <FolderSearch className="h-[14px] w-[14px]" />
        </button>
      </div>

      {/* 主体四态: 加载 / 错误 / 二进制 / 高亮源码 */}
      {kind === "loading" ? (
        <div className="grid flex-1 place-items-center">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        </div>
      ) : kind === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-label text-err">
          <AlertCircle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : kind === "binary" ? (
        <div className="p-4">
          <EmptyHint icon={<File className="h-5 w-5" />} title="二进制或非文本文件">
            不支持内联代码预览，可用系统默认程序打开
          </EmptyHint>
          <div className="mt-3 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => void openWithSystem(path)}
              className="flex items-center gap-1 rounded-md bg-accent px-3 py-2 text-label font-medium text-on-accent transition-opacity duration-fast ease-out hover:opacity-90"
            >
              <ExternalLink className="h-3 w-3" />
              默认程序打开
            </button>
            <button
              type="button"
              onClick={() => void revealPath(path)}
              className="flex items-center gap-1 rounded-md border border-line bg-card px-3 py-2 text-label text-fg-2 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
            >
              <FolderSearch className="h-3 w-3" />
              定位文件
            </button>
          </div>
        </div>
      ) : file && file.content === "" ? (
        <div className="grid flex-1 place-items-center text-label text-fg-4">空文件</div>
      ) : (
        <div className="fv-inline min-h-0 flex-1 overflow-auto">
          <div className="fv-code">
            {lines.map((l, i) => (
              <div key={i} className="fv-line">
                <span className="fv-ln">{i + 1}</span>
                {html ? (
                  <span className="fv-text" dangerouslySetInnerHTML={{ __html: html[i] ?? "" }} />
                ) : (
                  <span className="fv-text">{l}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 底部元信息行 */}
      {kind === "text" && file && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-3 py-2 text-meta tabular-nums text-fg-4">
          <span>{lines.length.toLocaleString()} 行</span>
          <span>·</span>
          <span>{formatSize(file.size)}</span>
          <span>·</span>
          <span>{file.encoding}</span>
          {lang && (
            <>
              <span>·</span>
              <span className="font-mono">{lang}</span>
            </>
          )}
          {file.truncated && <span className="text-warn">· 仅前 1MB</span>}
          {!html && (lines.length > HL_MAX_LINES || text.length > HL_MAX_CHARS) && (
            <span>· 过大免高亮</span>
          )}
        </div>
      )}
    </div>
  );
}
