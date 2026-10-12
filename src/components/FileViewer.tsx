import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, ExternalLink, FolderSearch, Loader2, X } from "lucide-react";
import { useUiStore } from "../store/ui";
import { useThemeStore } from "../store/theme";
import { highlightLines, langFromFilename } from "../lib/highlighter";
import { openWithSystem, revealPath } from "../lib/localPath";
import { useEscapeLayer } from "./settings/models/shared";
import { CopyButton } from "./ui";

interface TextFile {
  content: string;
  size: number;
  truncated: boolean;
  encoding: string;
}

// 超过这个量级不做语法高亮: shiki 同步高亮会卡住主线程, 大文件纯文本照样能看
const HL_MAX_LINES = 3000;
const HL_MAX_CHARS = 300_000;

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 程序内文件查看器 (会话里点开的文本文件): 只读, 带行号与高亮, 可跳到指定行。
// App 顶层唯一实例, 由 ui.viewer 驱动; key 含路径与行号, 换文件时整体重建, 不残留旧状态
export function FileViewer() {
  const viewer = useUiStore((s) => s.viewer);
  if (!viewer) return null;
  return <FileViewerDialog key={`${viewer.path}\0${viewer.line}`} path={viewer.path} line={viewer.line} />;
}

function FileViewerDialog({ path, line }: { path: string; line: number | null }) {
  const close = useUiStore((s) => s.closeViewer);
  const base = useThemeStore((s) => s.activeBase);
  const [file, setFile] = useState<TextFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, close);

  useEffect(() => {
    let alive = true;
    invoke<TextFile>("read_text_file", { path })
      .then((f) => alive && setFile(f))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  const name = path.split(/[\\/]/).pop() || path;
  // shiki 按 \n 切行, \r 会残留在 token 里; 统一换行后再切, 末尾换行不算一行
  const text = useMemo(() => (file ? file.content.replace(/\r\n?/g, "\n").replace(/\n$/, "") : ""), [file]);
  const lines = useMemo(() => (file ? text.split("\n") : []), [file, text]);
  const html = useMemo(() => {
    const lang = langFromFilename(path);
    if (!lang || lines.length > HL_MAX_LINES || text.length > HL_MAX_CHARS) return null;
    return highlightLines(text, lang);
    // base 参与依赖: 切皮肤后按新主题重新取色 (highlighter 缓存 key 已含主题)
  }, [path, text, lines.length, base]);

  // 内容就绪后滚到目标行; 行号越界时夹到最后一行
  useEffect(() => {
    if (!file || !line || !scrollRef.current) return;
    const target = Math.min(line, lines.length);
    scrollRef.current.querySelector(`[data-ln="${target}"]`)?.scrollIntoView({ block: "center" });
  }, [file, line, lines.length]);

  const iconBtn =
    "grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--fg-3)] transition-colors duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]";

  return (
    <div
      data-overlay
      className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={name}
        className="view-in-soft flex h-[min(85vh,900px)] w-[min(1100px,100%)] flex-col overflow-hidden rounded-lg border border-[var(--line-2)] bg-[var(--popover)] shadow-[var(--shadow)]"
      >
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--line)] py-3 pl-5 pr-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-title font-semibold text-[var(--fg)]">{name}</div>
            <div className="mt-1 truncate font-mono text-mini text-[var(--fg-4)]" title={path}>
              {path}
            </div>
          </div>
          <CopyButton text={path} title="复制路径" className="h-7 w-7" />
          <button onClick={() => void openWithSystem(path)} title="用默认程序打开" className={iconBtn}>
            <ExternalLink className="h-4 w-4" />
          </button>
          <button onClick={() => void revealPath(path)} title="在资源管理器中定位" className={iconBtn}>
            <FolderSearch className="h-4 w-4" />
          </button>
          <button onClick={close} title="关闭 (Esc)" className={iconBtn}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 四态: 错误 / 加载 / 空文件 / 内容 */}
        {error ? (
          <div className="grid flex-1 place-content-center justify-items-center gap-2 text-label text-[var(--err)]">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        ) : !file ? (
          <div className="grid flex-1 place-items-center">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
          </div>
        ) : file.content === "" ? (
          <div className="grid flex-1 place-items-center text-label text-[var(--fg-4)]">空文件</div>
        ) : (
          <div ref={scrollRef} className="fv-scroll min-h-0 flex-1 overflow-auto">
            <div className="fv-code">
              {lines.map((l, i) => (
                <div key={i} data-ln={i + 1} className={`fv-line${line === i + 1 ? " hit" : ""}`}>
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

        {file && (
          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--line)] px-5 py-2 text-mini tabular-nums text-[var(--fg-4)]">
            <span>{lines.length.toLocaleString()} 行</span>
            <span>·</span>
            <span>{formatSize(file.size)}</span>
            <span>·</span>
            <span>{file.encoding}</span>
            {file.truncated && <span className="text-[var(--warn)]">· 文件过大, 仅显示前 1 MB</span>}
            {!html && (lines.length > HL_MAX_LINES || text.length > HL_MAX_CHARS) && (
              <span>· 文件较大, 未做语法高亮</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
