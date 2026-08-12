import { memo } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createHighlighter } from "shiki";
import type { Highlighter } from "shiki";
import type { Element } from "hast";
import { useThemeStore } from "../store/theme";

// Markdown 渲染封装: react-markdown + GFM(表格/删除线/任务列表) + Shiki 语法高亮
// Shiki 使用 VS Code 同款 TextMate 语法, 对真实代码(注解/泛型/lambda/链式调用)识别率远高于 highlight.js
// react-markdown 管线是同步的, 所以不能直接用异步 rehype 插件:
// 改为模块级预热 highlighter + 自定义 pre 组件同步高亮, 未就绪时回退纯文本

// 常用语言清单(覆盖真实会话数据的高频标记, 其余未知标记回退为纯文本)
const LANGS = [
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
let currentTheme: "github-light" | "github-dark" = "github-light";
void createHighlighter({ langs: LANGS, themes: ["github-light", "github-dark"] }).then((h) => {
  highlighter = h;
});

// 高亮结果缓存: 流式更新时同一代码块只重新高亮一次, 避免每帧重复解析
// key 含主题: 切皮肤后旧主题缓存不命中, 重新高亮 (防缓存串主题)
// 带容量上限的 FIFO 淘汰, 防止长时间会话内存膨胀
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
const highlightCache = new BoundedCache<string, string>();

// 代码块渲染: 从 pre 代理 code 的 props, 同步调用 shiki 高亮
// lang 未知或 highlighter 未就绪时回退到默认 pre/code 渲染(纯文本)
function CodeBlock({ children }: { children?: ReactNode }) {
  const codeEl = children as
    | { props?: { className?: string; children?: ReactNode } }
    | undefined;
  const className = codeEl?.props?.className;
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  const raw = codeEl?.props?.children;

  if (lang && typeof raw === "string" && highlighter) {
    const code = raw.replace(/\n$/, "");
    const cacheKey = `${currentTheme}\u0000${lang}\u0000${code}`;
    let html = highlightCache.get(cacheKey);
    if (!html) {
      try {
        html = highlighter.codeToHtml(code, { lang, theme: currentTheme });
      } catch {
        return <pre>{children}</pre>;
      }
      highlightCache.set(cacheKey, html);
    }
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <pre>{children}</pre>;
}

// memo 保证流式更新时只有文本变化的条目重新解析, 其余条目跳过重渲染
// 内部订阅 activeBase: 皮肤 base 变化时 store 通知 → 组件重渲染 (不受 memo props 比较限制)
// → CodeBlock 重跑 codeToHtml 用新主题
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const base = useThemeStore((s) => s.activeBase);
  currentTheme = base === "dark" ? "github-dark" : "github-light";
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ pre: CodeBlock }}
        // 单换行渲染成 <br>: CommonMark 默认把软换行 (单个 \n) 折叠成空格,
        // 导致输入框里的换行发送后丢失; 拦截 remark-rehype 的 softbreak handler
        // 改返回 <br> 元素, 保留用户输入的换行格式 (零新依赖)
        remarkRehypeOptions={{
          handlers: {
            // softbreak 节点 @types/mdast 未声明 (不在 Nodes 联合), 但运行时 remark-rehype 会查 handlers.softbreak;
            // @ts-expect-error softbreak 不在 mdast Nodes 类型联合中
            softbreak: (): Element => ({ type: "element", tagName: "br", properties: {}, children: [] }),
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
