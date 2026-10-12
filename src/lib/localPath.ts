// 会话里的本地路径: 识别 (行内代码 / 正文绝对路径 / markdown 链接) + 解析 + 分发打开。
// 解析与文本判定在 Rust (local_path.rs), 这里只做「像不像路径」的廉价判断和打开路由
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/session";
import { useUiStore } from "../store/ui";

export interface ResolvedPath {
  path: string;
  kind: "text" | "file" | "dir";
  line: number | null;
}

// 行号后缀: `:42` / `:42:7` / GitHub 风格 `#L42` / `#L42-L50`
const LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;
const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\[^\\\s]|~[\\/])/;
// 文件名非法字符 (Windows): 含这些的行内代码一定不是路径 (泛型 Map<K,V>、管道 a|b 等)
const ILLEGAL = /[<>"|*?]/;

/**
 * 行内代码是否像路径。宁漏勿滥: 误判会把普通代码染成链接样式,
 * 漏判只是少一个快捷入口。规则:
 * - Windows 绝对路径 / UNC / `~/` → 是 (允许空格, 如 Program Files)
 * - 相对路径必须含分隔符、无空白、无协议, 且末段有扩展名或以分隔符结尾 (`src/`、`a/b.ts`)
 * - 排除 npm 包名 `@scope/pkg`、分数 `1/2`、以 `/` 开头的 URL 路由 `/api/users`
 */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.includes("://") || t.includes("\n")) return false;
  const body = t.replace(LINE_SUFFIX, "");
  if (ILLEGAL.test(body)) return false;
  if (WIN_ABS.test(body)) return body.length > 3;
  if (/\s/.test(body) || !/[\\/]/.test(body)) return false;
  if (body.startsWith("@") || body.startsWith("/") || /^[\d/\\.]+$/.test(body)) return false;
  // 冒号只允许出现在盘符位, 相对路径里出现说明是 `a:b/c` 这类别的东西
  if (body.includes(":")) return false;
  const last = body.split(/[\\/]/).pop() ?? "";
  return last === "" || /\.[A-Za-z0-9_-]{1,10}$/.test(last);
}

// 正文里的 Windows 绝对路径 (不含空格; 带空格的路径只能靠行内代码识别)。
// 盘符前不能紧跟字母数字、`:/` 后不能再跟 `/`: 否则 `https://x` 会被截出 `s://x`
// 中文全角标点不会出现在路径里, 却常紧贴路径出现 (`C:\a.bat，看看`), 遇到即截断;
// 中文文字本身合法 (C:\Users\汉江), 不能排除
// 只配 matchAll 使用 (带 g 标志, 用 test 会受 lastIndex 影响)
export const WIN_ABS_IN_TEXT = /(?<![A-Za-z0-9])[A-Za-z]:(?:\\|\/(?!\/))[^\s<>"'`|*?，。；：！？、（）《》「」『』【】“”‘’]*/g;
// 句末标点会被贪婪匹配进路径, 截掉 (路径本身以这些字符结尾极少见)
const TRAILING_PUNCT = /[.,;:!?)\]}）。，；：、！？》」』]+$/;
export function trimPathTail(p: string): string {
  return p.replace(TRAILING_PUNCT, "");
}

export function isExternalUrl(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

/** 当前活动会话的 cwd: 点击时读一次, 不订阅 (Markdown 被时间线 / 舰队 / Trellis 侧栏共用, 都属当前项目) */
function activeCwd(): string | null {
  const s = useSessionStore.getState();
  return s.activeSessionId ? (s.sessions[s.activeSessionId]?.cwd ?? null) : null;
}

export async function resolvePath(raw: string): Promise<ResolvedPath> {
  return invoke<ResolvedPath>("resolve_local_path", { raw, cwd: activeCwd() });
}

function notifyError(e: unknown) {
  useSessionStore.getState().notify(String(e));
}

/** 左键: 文本 → 程序内查看器; 非文本 / 目录 → 系统默认程序 */
export async function openPath(raw: string) {
  try {
    const r = await resolvePath(raw);
    if (r.kind === "text") {
      useUiStore.getState().openViewer(r.path, r.line);
    } else {
      await invoke("open_local_path", { path: r.path });
    }
  } catch (e) {
    notifyError(e);
  }
}

/** 已解析的绝对路径交给系统默认程序 */
export async function openWithSystem(path: string) {
  try {
    await invoke("open_local_path", { path });
  } catch (e) {
    notifyError(e);
  }
}

export async function revealPath(path: string) {
  try {
    await invoke("reveal_local_path", { path });
  } catch (e) {
    notifyError(e);
  }
}

export async function openExternal(url: string) {
  try {
    await invoke("open_external_url", { url });
  } catch (e) {
    notifyError(e);
  }
}
