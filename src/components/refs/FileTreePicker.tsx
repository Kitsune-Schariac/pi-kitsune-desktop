import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRight, ChevronDown, Folder, FileText, Check,
  Loader2, AlertCircle, Circle,
} from "lucide-react";
import type { PathRef } from "../../lib/refs";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  mtime: number | null;
}

// 常见重目录默认不展示: 展开会卡 UI, 引用场景很少需要它们
const HIDDEN_DIRS = new Set([
  "node_modules", ".git", "dist", "target", ".next", ".turbo",
  "build", ".cache", "__pycache__", ".venv", "venv", ".trellis",
]);

// 单行树节点 (目录懒加载展开 / 文件点击复选)
function TreeRow({ entry, depth, openSet, childrenMap, selected, onToggle, onSelect }: {
  entry: DirEntry;
  depth: number;
  openSet: Set<string>;
  childrenMap: Record<string, DirEntry[] | undefined>;
  selected: Map<string, DirEntry>;
  onToggle: (path: string) => void;
  onSelect: (e: DirEntry) => void;
}) {
  if (!entry.is_dir) {
    const sel = selected.has(entry.path);
    return (
      <button
        onClick={() => onSelect(entry)}
        className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition ${
          sel ? "bg-orange-50 text-orange-700" : "text-neutral-600 hover:bg-neutral-100"
        }`}
        style={{ paddingLeft: depth * 14 + 6 }}
        title={entry.path}
      >
        {sel ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-orange-500" />
        ) : (
          <Circle className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
        )}
        <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <span className="truncate">{entry.name}</span>
      </button>
    );
  }
  const isOpen = openSet.has(entry.path);
  const kids = childrenMap[entry.path];
  return (
    <div>
      <button
        onClick={() => onToggle(entry.path)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-neutral-700 transition hover:bg-neutral-100"
        style={{ paddingLeft: depth * 14 + 4 }}
        title={entry.path}
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0 text-orange-400" />
        <span className="truncate">{entry.name}</span>
        {isOpen && !kids && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-neutral-300" />}
      </button>
      {isOpen && kids && (
        <div>
          {kids
            .filter((k) => !(k.is_dir && HIDDEN_DIRS.has(k.name)))
            .map((k) => (
              <TreeRow
                key={k.path}
                entry={k}
                depth={depth + 1}
                openSet={openSet}
                childrenMap={childrenMap}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
        </div>
      )}
    </div>
  );
}

// 项目文件树多选引用: 从 root 起步懒加载, 确认后回调 PathRef 列表
export function FileTreePicker({ root, onPick, onDone }: {
  root: string;
  onPick: (refs: PathRef[]) => void;
  onDone: () => void;
}) {
  const [openSet, setOpenSet] = useState<Set<string>>(new Set([root]));
  const [childrenMap, setChildrenMap] = useState<Record<string, DirEntry[] | undefined>>({ [root]: undefined });
  const [selected, setSelected] = useState<Map<string, DirEntry>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const toggle = async (path: string) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!childrenMap[path]) {
      try {
        const list = await invoke<DirEntry[]>("list_dir", { root, path });
        setChildrenMap((prev) => ({ ...prev, [path]: list }));
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    }
  };

  // 根目录默认展开: 挂载时自动加载一次子节点
  useEffect(() => {
    if (!childrenMap[root]) {
      invoke<DirEntry[]>("list_dir", { root, path: root })
        .then((list) => setChildrenMap((prev) => ({ ...prev, [root]: list })))
        .catch((e) => setError(String(e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const toggleSelect = (e: DirEntry) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(e.path)) next.delete(e.path);
      else next.set(e.path, e);
      return next;
    });
  };

  const confirm = () => {
    if (selected.size === 0) return;
    onPick(
      [...selected.values()].map((e) => ({
        kind: "file" as const,
        title: e.name,
        path: e.path,
        meta: { size: e.size ?? undefined },
      }))
    );
    onDone();
  };

  return (
    <div className="flex h-60 flex-col">
      <div className="flex-1 overflow-auto rounded-lg border border-neutral-200 bg-white p-1.5">
        <TreeRow
          entry={{ name: root.split(/[\\/]/).pop() || root, path: root, is_dir: true, size: null, mtime: null }}
          depth={0}
          openSet={openSet}
          childrenMap={childrenMap}
          selected={selected}
          onToggle={toggle}
          onSelect={toggleSelect}
        />
      </div>
      {error && (
        <p className="mt-1 flex items-center gap-1 px-1 text-[11px] text-red-500">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-neutral-400">
          已选 {selected.size} 个文件 · 点击文件复选
        </span>
        <button
          onClick={confirm}
          disabled={selected.size === 0}
          className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs text-white transition hover:bg-orange-600 disabled:opacity-40"
        >
          添加引用
        </button>
      </div>
    </div>
  );
}
