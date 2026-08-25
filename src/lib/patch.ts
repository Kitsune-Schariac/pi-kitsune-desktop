// Unified patch 纯函数解析器 (无 React 依赖, 可单测)
// 解析标准 unified diff: 文件头 (--- / +++)、hunk 头 (@@ -a,b +c,d @@)、
// 三类内容行 (空格/-/+)、`\ No newline at end of file` 标记。
// 行号在解析阶段一次算好挂到每行, 渲染层不再做算术。
// 任何畸形输入返回 null, 由渲染层降级为纯文本显示原始字符串, 绝不抛异常。

export interface PatchLine {
  kind: "context" | "add" | "del";
  text: string;
  oldNo: number | null; // 增行无旧号
  newNo: number | null; // 删行无新号
  // `\ No newline at end of file` 跟在该内容行后, 标记到该行; 渲染时在行尾给提示
  noNewline?: boolean;
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: PatchLine[];
}

export interface PatchFile {
  oldPath: string;
  newPath: string;
  hunks: PatchHunk[];
}

/**
 * 解析标准 unified patch 文本。成功返回文件段数组 (edit 工具通常单文件, git diff 可多文件),
 * 失败 (空输入 / 格式不符 / hunk 行数与头声明不符) 返回 null。
 */
export function parseUnifiedPatch(text: string): PatchFile[] | null {
  if (!text) return null;
  // 按 \n 切后 strip 残留 \r (CRLF 输入会带 \r, 影响渲染与高亮)
  // 不预先裁剪末尾空串: 末尾空串可能是合法的空 context 行, 靠 hunk 行数计数决定何时结束
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const n = lines.length;
  const files: PatchFile[] = [];
  let i = 0;

  while (i < n) {
    // 定位文件头 --- (跳过可能存在的 diff --git / index 等前置行)
    if (!lines[i].startsWith("--- ")) {
      i++;
      continue;
    }
    const oldPath = lines[i].slice(4).trim();
    i++;
    // 有 --- 必须紧跟 +++ , 否则视为畸形
    if (i >= n || !lines[i].startsWith("+++ ")) return null;
    const newPath = lines[i].slice(4).trim();
    i++;
    const hunks: PatchHunk[] = [];
    while (i < n && lines[i].startsWith("@@")) {
      const res = parseHunk(lines, i);
      if (!res) return null;
      hunks.push(res.hunk);
      i = res.next;
    }
    // 文件头后必须至少有一个 hunk
    if (hunks.length === 0) return null;
    files.push({ oldPath, newPath, hunks });
  }

  return files.length > 0 ? files : null;
}

// hunk 头: @@ -a,b +c,d @@ [可选上下文描述]
// 行数省略时默认 1 (@@ -5 +5 @@ 合法)
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunk(lines: string[], start: number): { hunk: PatchHunk; next: number } | null {
  const m = HUNK_RE.exec(lines[start]);
  if (!m) return null;
  const oldStart = parseInt(m[1], 10);
  const oldLines = m[2] !== undefined ? parseInt(m[2], 10) : 1;
  const newStart = parseInt(m[3], 10);
  const newLines = m[4] !== undefined ? parseInt(m[4], 10) : 1;

  const hunkLines: PatchLine[] = [];
  let oldNo = oldStart;
  let newNo = newStart;
  let oldCount = 0;
  let newCount = 0;
  let i = start + 1;

  // 循环到两个计数都达到声明行数为止; 但 `\ No newline` 标记可能在计数满后仍出现, 需继续消费
  while (i < lines.length) {
    const line = lines[i];

    // `\ No newline at end of file`: 元信息, 不参与行号推进, 标记到上一个内容行
    if (line.startsWith("\\")) {
      const last = hunkLines[hunkLines.length - 1];
      if (last) last.noNewline = true;
      i++;
      continue;
    }

    // 计数已满 → hunk 结束 (后续行交给外层找下一个 @@ 或 --- )
    if (oldCount >= oldLines && newCount >= newLines) break;

    if (line === "") {
      // 空行: 部分生成器用完全空行代替单空格的上下文行, 两者同等按 context 处理。
      // 若按「首字符不是 +/-/空格 → 跳过」会把空行吞掉, 导致后续行号全部错位。
      hunkLines.push({ kind: "context", text: "", oldNo: oldNo++, newNo: newNo++ });
      oldCount++;
      newCount++;
      i++;
      continue;
    }

    const ch = line[0];
    if (ch === " ") {
      hunkLines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      oldCount++;
      newCount++;
    } else if (ch === "+") {
      hunkLines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
      newCount++;
    } else if (ch === "-") {
      hunkLines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
      oldCount++;
    } else {
      // hunk 内 (计数未满时) 出现非法首字符 → 畸形, 不强行容错以免行号错位
      return null;
    }
    i++;
  }

  // 行数与 hunk 头声明不符 → 畸形
  if (oldCount !== oldLines || newCount !== newLines) return null;
  return { hunk: { oldStart, oldLines, newStart, newLines, lines: hunkLines }, next: i };
}