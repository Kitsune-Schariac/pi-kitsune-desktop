import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Markdown 渲染封装: react-markdown + GFM(表格/删除线/任务列表)
// memo 保证流式更新时只有文本变化的条目重新解析, 其余条目跳过重渲染
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});
