// Shiki 语法高亮单例 (从 Markdown.tsx 抽出, 供 Markdown 与 DiffView 共用)
// 抽取动机: DiffView 需要按行高亮, 若自行 createHighlighter 会二次加载约 50 个语言的
// TextMate 语法 (重初始化) 且两份缓存互不共享。这里导出同一实例 + 同一份缓存。
import { createHighlighter } from "shiki";
import type { BundledLanguage, Highlighter } from "shiki";
import { useThemeStore } from "../store/theme";

// 常用语言清单 (覆盖真实会话数据的高频标记, 其余未知标记回退为纯文本)
export const LANGS = [
  "java", "javascript", "typescript", "tsx", "jsx", "bash", "shell", "sh",
  "python", "go", "rust", "json", "xml", "yaml", "sql", "css", "html",
  "markdown", "dart", "powershell", "kotlin", "swift", "csharp", "cpp",
  "c", "php", "ruby", "vue", "properties", "toml", "ini", "diff",
  "makefile", "lua", "perl", "less", "scss", "graphql", "wasm", "http",
  "jsonc", "dockerfile", "bat", "batch", "objc", "nginx", "regex",
];

// highlighter 预热: 应用启动即后台加载, 用户看到第一条消息时通常已就绪
// 双主题预加载: 皮肤 base=dark 时切 github-dark (浅色保持 github-light)
let highlighter: Highlighter | null = null;
// currentTheme 由 theme store 的 activeBase 驱动 (取代原 Markdown.tsx 在渲染期间赋值的副作用)。
// 模块内订阅 store: 任何 set 都会触发, 这里只做一次赋值, 开销可忽略。
let currentTheme: "github-light" | "github-dark" =
  useThemeStore.getState().activeBase === "dark" ? "github-dark" : "github-light";
useThemeStore.subscribe((state) => {
  currentTheme = state.activeBase === "dark" ? "github-dark" : "github-light";
});

void createHighlighter({ langs: LANGS, themes: ["github-light", "github-dark"] }).then((h) => {
  highlighter = h;
});

// 带容量上限的 FIFO 淘汰缓存, 防止长时间会话内存膨胀
const CACHE_LIMIT = 500;
class BoundedCache<K, V> extends Map<K, V> {
  set(key: K, value: V) {
    super.set(key, value);
    if (this.size > CACHE_LIMIT) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return this;
  }
}
// 整块高亮缓存 (Markdown CodeBlock 用) + 按行高亮缓存 (DiffView 用), 各管各的 key 空间
const htmlCache = new BoundedCache<string, string>();
const lineCache = new BoundedCache<string, string[]>();

export function getHighlighter(): Highlighter | null {
  return highlighter;
}

// 整块高亮: 返回 shiki codeToHtml 的完整 <pre> HTML (Markdown CodeBlock 用, 逻辑与原实现一致)
// 缓存 key 必须含主题: 切皮肤后旧主题缓存不命中, 重新高亮 (防缓存串主题)
export function highlightToHtml(code: string, lang: string): string | null {
  if (!highlighter) return null;
  const key = `${currentTheme}\u0000${lang}\u0000${code}`;
  const hit = htmlCache.get(key);
  if (hit) return hit;
  try {
    const html = highlighter.codeToHtml(code, { lang, theme: currentTheme });
    htmlCache.set(key, html);
    return html;
  } catch {
    return null;
  }
}

// 按行高亮: 返回每行一段 HTML (含 <span style="color:...">), 供 DiffView 双侧分别取色
// highlighter 未就绪 / 语言未命中 → 返回 null, 调用方降级纯文本 (不阻塞渲染)
export function highlightLines(code: string, lang: string): string[] | null {
  if (!highlighter) return null;
  const key = `${currentTheme}\u0000${lang}\u0000${code}`;
  const hit = lineCache.get(key);
  if (hit) return hit;
  try {
    // codeToTokens 的 lang 参数类型比 codeToHtml 严格 (要求 BundledLanguage 字面量联合),
    // 调用方传入的是运行时 string, 断言回窄类型 —— lang 已在 LANGS 预热清单内, 运行时安全
    const { tokens } = highlighter.codeToTokens(code, { lang: lang as BundledLanguage, theme: currentTheme });
    const lines = tokens.map((line) => line.map(tokenToHtml).join(""));
    lineCache.set(key, lines);
    return lines;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ThemedToken 结构: { content: string; color?: string; fontStyle? }。用结构类型避免直接依赖
// @shikijs/types (项目未显式声明该依赖, pnpm 严格模式可能解析不到)
function tokenToHtml(t: { content: string; color?: string }): string {
  const color = t.color ? ` style="color:${t.color}"` : "";
  return `<span${color}>${escapeHtml(t.content)}</span>`;
}

// 文件扩展名 → shiki 语言 id 推断 (DiffView 按文件类型高亮用)。未命中返回 null → 降级纯文本
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", rs: "rust", go: "go", java: "java",
  json: "json", jsonc: "jsonc", json5: "json",
  yml: "yaml", yaml: "yaml", toml: "toml",
  css: "css", scss: "scss", less: "less", sass: "scss",
  html: "html", htm: "html", xml: "xml", svg: "xml",
  md: "markdown", markdown: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", ps: "powershell",
  sql: "sql", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", kt: "kotlin", kts: "kotlin", swift: "swift",
  php: "php", rb: "ruby", vue: "vue", svelte: "html",
  lua: "lua", pl: "perl", pm: "perl", dart: "dart",
  graphql: "graphql", gql: "graphql", wasm: "wasm", http: "http",
  ini: "ini", properties: "properties", props: "properties", conf: "ini",
  cfg: "ini", bat: "bat", cmd: "batch",
  tfvars: "terraform", tf: "terraform",
};

export function langFromFilename(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const lower = base.toLowerCase();
  // 无扩展名的特殊文件名先判 (dockerfile / makefile 等)
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "dockerfile";
  if (lower === "makefile" || lower.startsWith("makefile.")) return "makefile";
  if (lower === "justfile") return "makefile";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  if (EXT_LANG[ext]) return EXT_LANG[ext];
  // 未知扩展名但 LANGS 里可能有同名语言 id (兜底)
  if (LANGS.includes(ext)) return ext;
  return null;
}