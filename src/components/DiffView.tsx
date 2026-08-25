import { memo, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { parseUnifiedPatch } from "../lib/patch";
import type { PatchFile, PatchHunk, PatchLine } from "../lib/patch";
import { highlightLines, langFromFilename } from "../lib/highlighter";
import { useThemeStore } from "../store/theme";

// 单 hunk 超过此行数时中段折叠为可展开条, 避免一个超大 hunk 撑满整个卡片
const FOLD_THRESHOLD = 40;
const FOLD_HEAD = 12;
const FOLD_TAIL = 12;

// 纯文本降级用的转义 (highlightLines 未就绪 / 语言未命中时走这条)
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// patch 头里的绝对路径相对会话 cwd 显示; 不在 cwd 下则原样返回。
// 同时剥掉 git diff 的 a/ b/ 前缀 (edit 工具无前缀, 剥不剥都不影响)
function relPath(p: string, cwd?: string): string {
  const stripped = p.replace(/^([ab])\//, "");
  if (!cwd) return stripped;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const c = norm(cwd);
  const a = norm(stripped);
  if (a.startsWith(c + "/")) return stripped.slice(c.length + 1);
  return p;
}

// 过长路径中段省略: 保留首段 (盘符/根) + 末两段 (目录/文件名, 尾部信息量最大)
function shortenPath(p: string, max = 56): string {
  if (p.length <= max) return p;
  const segs = p.split(/[\\/]/);
  if (segs.length < 3) return p;
  const s = `${segs[0]}/…/${segs.slice(-2).join("/")}`;
  return s.length < p.length ? s : p;
}

// unified patch 渲染组件: 双列行号 + hunk 结构 + 语法高亮 + 主题自适应。
// 放 components/ 根目录与 ToolCallCard 平级, 后续 Git 面板可直接 import 复用。
export const DiffView = memo(function DiffView({ patch, cwd }: { patch: string; cwd?: string }) {
  // 订阅 activeBase: 切皮肤时触发自身重渲染, 并把 base 透传给 HunkRows 让其双侧高亮
  // useMemo 失效重算 (highlighter 缓存 key 含主题, 新主题下重新高亮, 不命中旧主题缓存)
  const themeBase = useThemeStore((s) => s.activeBase);
  const files = useMemo(() => parseUnifiedPatch(patch), [patch]);

  // 解析失败 → 降级渲染原始文本, 不白屏 (畸形 patch 不能让整条消息流崩)
  if (!files) {
    return (
      <pre
        className="mt-2 overflow-auto rounded p-2 text-xs text-neutral-700"
        style={{
          background: "rgb(var(--code-bg) / var(--code-alpha))",
          border: "1px solid rgb(var(--border-subtle))",
        }}
      >
        {patch}
      </pre>
    );
  }

  return (
    <div
      className="mt-2 max-h-[60vh] overflow-auto rounded text-xs"
      style={{ border: "1px solid rgb(var(--border-subtle))" }}
    >
      {files.map((file: PatchFile, fi: number) => {
        const lang = langFromFilename(file.newPath) ?? undefined;
        const oldRel = shortenPath(relPath(file.oldPath, cwd));
        const newRel = shortenPath(relPath(file.newPath, cwd));
        const head = oldRel === newRel ? oldRel : `${oldRel} → ${newRel}`;
        return (
          <div
            key={fi}
            style={fi > 0 ? { borderTop: "1px solid rgb(var(--border-subtle))" } : undefined}
          >
            <div
              className="truncate px-2 py-1 font-mono text-[11px] text-neutral-500"
              title={file.newPath}
            >
              {head}
            </div>
            <table className="w-full border-collapse font-mono leading-relaxed">
              <tbody>
                {file.hunks.map((hunk: PatchHunk, hi: number) => (
                  <HunkRows
                    key={hi}
                    hunk={hunk}
                    lang={lang}
                    themeBase={themeBase}
                    prevHunk={hi > 0 ? file.hunks[hi - 1] : null}
                  />
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
});

// 单 hunk 渲染: 分隔行 (非首 hunk) + hunk 头 + 行列表 (中段可折叠)。
// 双侧分别高亮 (design 二-2.3): 剥掉 +/- 前缀后增删行混在一起是语法不合法的代码,
// 一次性整段高亮会让语法解析错乱; 旧侧 (上下文+删) 与新侧 (上下文+增) 各自拼成合法片段分别高亮
function HunkRows({
  hunk,
  lang,
  themeBase,
  prevHunk,
}: {
  hunk: PatchHunk;
  lang?: string;
  themeBase: "light" | "dark";
  prevHunk: PatchHunk | null;
}) {
  const [folded, setFolded] = useState(hunk.lines.length > FOLD_THRESHOLD);

  // 把 hunk 行拆到 old/new 两侧, 各自拼成合法代码片段高亮; 同时记每行在两侧高亮结果里的索引,
  // 供渲染时按行取色 (上下文行两侧都有索引, 删行只有旧侧, 增行只有新侧)
  const hl = useMemo(() => {
    const oldCode: string[] = [];
    const newCode: string[] = [];
    const oldMap: (number | null)[] = [];
    const newMap: (number | null)[] = [];
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        oldMap.push(oldCode.length);
        oldCode.push(line.text);
        newMap.push(newCode.length);
        newCode.push(line.text);
      } else if (line.kind === "del") {
        oldMap.push(oldCode.length);
        oldCode.push(line.text);
        newMap.push(null);
      } else {
        oldMap.push(null);
        newMap.push(newCode.length);
        newCode.push(line.text);
      }
    }
    // highlightLines 返回 null (未就绪/语言未命中) 时整段降级纯文本, 不阻塞渲染
    const oldHtml = lang ? highlightLines(oldCode.join("\n"), lang) : null;
    const newHtml = lang ? highlightLines(newCode.join("\n"), lang) : null;
    return { oldMap, newMap, oldHtml, newHtml };
  }, [hunk, lang, themeBase]);

  // 取某行的高亮 HTML: 删行取旧侧, 上下文与增行取新侧 (上下文两侧一致, 取新侧)。
  // 未命中高亮 → 转义纯文本兜底; noNewline 行尾附 "no newline" 标记
  const rowHtml = (line: PatchLine, i: number): string => {
    let base: string;
    if (line.kind === "del") {
      const oi = hl.oldMap[i];
      base = hl.oldHtml && oi !== null ? hl.oldHtml[oi] : escapeHtml(line.text);
    } else {
      const ni = hl.newMap[i];
      base = hl.newHtml && ni !== null ? hl.newHtml[ni] : escapeHtml(line.text);
    }
    if (line.noNewline) {
      base +=
        '<span style="color:rgb(var(--neutral-400));font-size:10px;margin-left:.25em">no newline</span>';
    }
    return base;
  };

  const rows: ReactNode[] = [];

  // 非首 hunk 前插分隔行: 显示跳过的行数, 不伪造成连续文件
  if (prevHunk) {
    const oldSkip = hunk.oldStart - (prevHunk.oldStart + prevHunk.oldLines);
    rows.push(
      <tr key="sep" style={{ borderTop: "1px solid rgb(var(--border-subtle))" }}>
        <td colSpan={4} className="py-0.5 text-center text-[11px] text-neutral-400">
          {oldSkip > 0 ? `⋯ 跳过 ${oldSkip} 行 ⋯` : "⋯"}
        </td>
      </tr>,
    );
  }

  // hunk 头
  rows.push(
    <tr
      key="head"
      style={{ background: "rgb(var(--surface-sunken) / var(--overlay-alpha))" }}
    >
      <td colSpan={4} className="px-2 py-0.5 text-[11px] text-neutral-600">
        {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
      </td>
    </tr>,
  );

  const lines = hunk.lines;
  const showAll = !folded || lines.length <= FOLD_THRESHOLD;
  // 折叠时保留头尾各 FOLD_HEAD/FOLD_TAIL 行, 中段换成可展开条
  const headEnd = showAll ? lines.length : Math.min(FOLD_HEAD, lines.length);
  const tailStart = showAll ? lines.length : Math.max(headEnd, lines.length - FOLD_TAIL);
  const foldedCount = tailStart - headEnd;

  for (let i = 0; i < headEnd; i++) {
    rows.push(<DiffRow key={i} line={lines[i]} html={rowHtml(lines[i], i)} />);
  }
  if (!showAll && foldedCount > 0) {
    rows.push(
      <tr key="fold">
        <td colSpan={4} className="py-0.5">
          <button
            onClick={() => setFolded(false)}
            className="flex w-full items-center justify-center gap-1 text-[11px] text-neutral-500 transition hover:text-neutral-700"
          >
            <ChevronDown className="h-3 w-3" />
            展开中间 {foldedCount} 行
          </button>
        </td>
      </tr>,
    );
  }
  for (let i = tailStart; i < lines.length; i++) {
    rows.push(<DiffRow key={i} line={lines[i]} html={rowHtml(lines[i], i)} />);
  }

  return <>{rows}</>;
}

// 单行: 双列行号 (增行旧号留空 / 删行新号留空) + +/- 字形前缀 (不让颜色成为唯一信息载体,
// 低对比皮肤与色觉障碍下仍可辨) + 高亮内容。table 布局让行号列等宽对齐
function DiffRow({ line, html }: { line: PatchLine; html: string }) {
  const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const bg =
    line.kind === "add"
      ? "rgb(var(--diff-add-bg) / var(--code-alpha))"
      : line.kind === "del"
        ? "rgb(var(--diff-del-bg) / var(--code-alpha))"
        : undefined;
  const fg =
    line.kind === "add"
      ? "rgb(var(--diff-add-fg))"
      : line.kind === "del"
        ? "rgb(var(--diff-del-fg))"
        : "rgb(var(--neutral-700))";
  return (
    <tr style={bg ? { background: bg } : undefined}>
      <td className="w-12 select-none px-2 text-right tabular-nums text-neutral-400">
        {line.oldNo ?? ""}
      </td>
      <td className="w-12 select-none px-2 text-right tabular-nums text-neutral-400">
        {line.newNo ?? ""}
      </td>
      <td className="w-4 select-none text-center" style={{ color: fg }}>
        {prefix}
      </td>
      <td
        className="whitespace-pre px-2"
        style={{ color: fg }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </tr>
  );
}

// details.diff 朴素着色回退 (details.patch 缺失时用, 如老版本 pi 或第三方工具)。
// pi 私有格式: 行号内嵌前缀、省略段是字面 ..., 无法还原双列行号, 这里只做逐行着色保证不白屏
export const PlainDiffView = memo(function PlainDiffView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre
      className="mt-2 max-h-[40vh] overflow-auto rounded p-2 text-xs leading-relaxed"
      style={{
        background: "rgb(var(--code-bg) / var(--code-alpha))",
        border: "1px solid rgb(var(--border-subtle))",
      }}
    >
      {lines.map((line, i) => {
        let color = "rgb(var(--neutral-600))";
        if (line.startsWith("+")) color = "rgb(var(--diff-add-fg))";
        else if (line.startsWith("-")) color = "rgb(var(--diff-del-fg))";
        // pi 的 details.diff 省略段 (字面 ...) 与行号前缀行都归次要色
        else if (line.startsWith("...") || /^\s*\d/.test(line)) color = "rgb(var(--neutral-400))";
        return (
          <div key={i} style={{ color }}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
});