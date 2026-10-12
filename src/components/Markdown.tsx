import { memo, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import type { Components, Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element } from "hast";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Eye, ExternalLink, FolderSearch } from "lucide-react";
import { useThemeStore } from "../store/theme";
import { useUiStore } from "../store/ui";
import { getHighlighter, highlightToHtml } from "../lib/highlighter";
import {
  WIN_ABS_IN_TEXT, isExternalUrl, looksLikePath, openExternal, openPath, openWithSystem,
  resolvePath, revealPath, trimPathTail, type ResolvedPath,
} from "../lib/localPath";
import { CopyButton } from "./ui";
import { ContextMenu, type MenuItem } from "./ProjectList";

// Markdown 渲染封装: react-markdown + GFM(表格/删除线/任务列表) + Shiki 语法高亮
// Shiki 使用 VS Code 同款 TextMate 语法, 对真实代码(注解/泛型/lambda/链式调用)识别率远高于 highlight.js
// react-markdown 管线是同步的, 所以不能直接用异步 rehype 插件:
// 改为模块级预热 highlighter + 自定义 pre 组件同步高亮, 未就绪时回退纯文本
// (shiki 单例、语言清单、主题联动与高亮缓存已抽到 lib/highlighter.ts, 供 DiffView 共用)

// 代码块渲染: 从 pre 代理 code 的 props, 同步调用 shiki 高亮; 右上角带复制钮
// 不渲染 children (那会走自定义 code 组件), 而是拿原文自拼 pre/code ——
// 这样自定义 code 组件只会被行内代码触发, 无需再区分行内 / 块级
function CodeBlock({ children }: { children?: ReactNode }) {
  const codeEl = children as
    | { props?: { className?: string; children?: ReactNode } }
    | undefined;
  const className = codeEl?.props?.className;
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  const raw = codeEl?.props?.children;
  const code = typeof raw === "string" ? raw.replace(/\n$/, "") : null;

  let body: ReactNode = null;
  if (lang && code !== null && getHighlighter()) {
    const html = highlightToHtml(code, lang);
    if (html) body = <div dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <div className="md-code">
      {body ?? (
        <pre>
          <code className={className}>{code ?? raw}</code>
        </pre>
      )}
      {code !== null && <CopyButton text={code} title="复制代码" className="md-code-copy" />}
    </div>
  );
}

// 可点击的本地路径: 左键按类型打开 (文本 → 查看器, 其余 → 系统程序), 右键弹菜单。
// 用 span 而非 a: 行内代码路径可能出现在 markdown 链接里, a 套 a 是非法嵌套
function PathLink({ raw, code, children }: { raw: string; code?: boolean; children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; resolved: ResolvedPath | null } | null>(null);

  const onContextMenu = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { clientX: x, clientY: y } = e;
    // 右键时先解析: 「程序内查看」是否可用取决于文件类型, 路径不存在时其余项置灰
    let resolved: ResolvedPath | null = null;
    try {
      resolved = await resolvePath(raw);
    } catch {
      /* 不存在: 菜单首项提示, 不额外弹 toast */
    }
    setMenu({ x, y, resolved });
  };

  const items: MenuItem[] = [];
  if (menu) {
    const r = menu.resolved;
    if (!r) items.push({ label: "路径不存在", disabled: true, onClick: () => {} });
    items.push(
      {
        label: "在程序内查看",
        icon: Eye,
        disabled: r?.kind !== "text",
        onClick: () => r && useUiStore.getState().openViewer(r.path, r.line),
      },
      { label: "用默认程序打开", icon: ExternalLink, disabled: !r, onClick: () => r && void openWithSystem(r.path) },
      { label: "在资源管理器中定位", icon: FolderSearch, disabled: !r, onClick: () => r && void revealPath(r.path) },
      {
        label: "复制路径",
        icon: Copy,
        onClick: () => void writeText(r?.path ?? raw).catch((err) => console.error("复制失败", err)),
      },
    );
  }

  return (
    <>
      <span
        role="link"
        tabIndex={0}
        title={raw}
        className={code ? "md-path md-path-code" : "md-path"}
        onClick={(e) => {
          e.preventDefault();
          void openPath(raw);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void openPath(raw);
        }}
        onContextMenu={(e) => void onContextMenu(e)}
      >
        {children}
      </span>
      {/* portal 到 body: 时间线条目带入场动画 transform, fixed 定位在 transform 祖先里会错位 */}
      {menu &&
        createPortal(
          <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />,
          document.body,
        )}
    </>
  );
}

// 链接: 外链交给系统浏览器 (否则 WebView 自己导航走, 整个应用界面被替换);
// 页内锚点不处理; 其余 href 视为本地路径 (相对路径按会话 cwd 解析)
function MdLink({ href = "", children }: { href?: string; children?: ReactNode }) {
  if (isExternalUrl(href)) {
    return (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault();
          void openExternal(href);
        }}
      >
        {children}
      </a>
    );
  }
  // 锚点、其他协议 (vscode:// 等) 不处理, 只拦住导航
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]+:\/\//i.test(href.replace(/^file:/i, ""))) {
    return <a onClick={(e) => e.preventDefault()}>{children}</a>;
  }
  let raw = href.replace(/^file:\/\/\/?/i, "");
  try {
    // markdown 链接里的中文 / 空格常被编码成 %XX
    raw = decodeURI(raw);
  } catch {
    /* 非法编码按原文 */
  }
  return <PathLink raw={raw}>{children}</PathLink>;
}

function InlineCode({ className, children }: { className?: string; children?: ReactNode }) {
  if (typeof children === "string" && looksLikePath(children)) {
    return (
      <PathLink raw={children} code>
        <code className={className}>{children}</code>
      </PathLink>
    );
  }
  return <code className={className}>{children}</code>;
}

// remark 插件: 正文纯文本里的 Windows 绝对路径 → link 节点, 交给 MdLink 渲染成可点路径。
// 只动 text 节点, 已有链接 / 代码的子树跳过; 手写递归, 不为一次遍历引入 unist-util-visit
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}
function linkifyWinPaths(node: MdNode) {
  if (!node.children) return;
  const out: MdNode[] = [];
  for (const child of node.children) {
    if (child.type !== "text" || !child.value) {
      if (child.type !== "link" && child.type !== "linkReference") linkifyWinPaths(child);
      out.push(child);
      continue;
    }
    const text = child.value;
    let last = 0;
    for (const m of text.matchAll(WIN_ABS_IN_TEXT)) {
      const path = trimPathTail(m[0]);
      if (path.length <= 3) continue;
      const start = m.index;
      if (start > last) out.push({ type: "text", value: text.slice(last, start) });
      out.push({ type: "link", url: path, children: [{ type: "text", value: path }] });
      last = start + path.length;
    }
    if (last === 0) out.push(child);
    else if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  }
  node.children = out;
}
const remarkWinPaths = () => (tree: MdNode) => linkifyWinPaths(tree);

// 默认 urlTransform 会把 `C:\...` 当成未知协议清空; 放宽为只拦危险协议。
// 所有 a 点击都被 MdLink 拦截, 不存在 WebView 导航
const urlTransform = (url: string) => (/^\s*(javascript|vbscript|data):/i.test(url) ? "" : url);

// 模块级常量: 每次渲染新建对象会让 react-markdown 失去引用稳定性
const REMARK_PLUGINS = [remarkGfm, remarkWinPaths];
const COMPONENTS: Components = { pre: CodeBlock, a: MdLink, code: InlineCode };
const REHYPE_OPTIONS: Options["remarkRehypeOptions"] = {
  handlers: {
    // softbreak 节点 @types/mdast 未声明 (不在 Nodes 联合), 但运行时 remark-rehype 会查 handlers.softbreak;
    // @ts-expect-error softbreak 不在 mdast Nodes 类型联合中
    softbreak: (): Element => ({ type: "element", tagName: "br", properties: {}, children: [] }),
  },
};

// memo 保证流式更新时只有文本变化的条目重新解析, 其余条目跳过重渲染
// 订阅 activeBase 仅用于在皮肤 base 变化时触发重渲染 (shiki 主题由 highlighter 模块自行维护),
// 不再在渲染期间赋值任何主题可变量 —— 消除原 Markdown.tsx:81 的渲染期副作用
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  useThemeStore((s) => s.activeBase);
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={COMPONENTS}
        urlTransform={urlTransform}
        // 单换行渲染成 <br>: CommonMark 默认把软换行 (单个 \n) 折叠成空格,
        // 导致输入框里的换行发送后丢失; 拦截 remark-rehype 的 softbreak handler
        // 改返回 <br> 元素, 保留用户输入的换行格式 (零新依赖)
        remarkRehypeOptions={REHYPE_OPTIONS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
