import { memo } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element } from "hast";
import { useThemeStore } from "../store/theme";
import { getHighlighter, highlightToHtml } from "../lib/highlighter";

// Markdown 渲染封装: react-markdown + GFM(表格/删除线/任务列表) + Shiki 语法高亮
// Shiki 使用 VS Code 同款 TextMate 语法, 对真实代码(注解/泛型/lambda/链式调用)识别率远高于 highlight.js
// react-markdown 管线是同步的, 所以不能直接用异步 rehype 插件:
// 改为模块级预热 highlighter + 自定义 pre 组件同步高亮, 未就绪时回退纯文本
// (shiki 单例、语言清单、主题联动与高亮缓存已抽到 lib/highlighter.ts, 供 DiffView 共用)

// 代码块渲染: 从 pre 代理 code 的 props, 同步调用 shiki 高亮
// lang 未知或 highlighter 未就绪时回退到默认 pre/code 渲染(纯文本)
function CodeBlock({ children }: { children?: ReactNode }) {
  const codeEl = children as
    | { props?: { className?: string; children?: ReactNode } }
    | undefined;
  const className = codeEl?.props?.className;
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  const raw = codeEl?.props?.children;

  if (lang && typeof raw === "string" && getHighlighter()) {
    const code = raw.replace(/\n$/, "");
    const html = highlightToHtml(code, lang);
    if (html) return <div dangerouslySetInnerHTML={{ __html: html }} />;
    return <pre>{children}</pre>;
  }
  return <pre>{children}</pre>;
}

// memo 保证流式更新时只有文本变化的条目重新解析, 其余条目跳过重渲染
// 订阅 activeBase 仅用于在皮肤 base 变化时触发重渲染 (shiki 主题由 highlighter 模块自行维护),
// 不再在渲染期间赋值任何主题可变量 —— 消除原 Markdown.tsx:81 的渲染期副作用
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  useThemeStore((s) => s.activeBase);
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