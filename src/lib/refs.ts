// 输入框「上下文引用」模型 + 发送组装纯函数
// 核心决策: 文本引用走路径模式 (内容不进上下文, agent 按需读);
// 无路径可用的源 (会话消息/剪贴板文本) 走内联内容; 图像一律 base64 进 images 字段

/** 路径类引用: 发送时转 [引用文件: path] 标记, 内容不进上下文 */
export interface PathRef {
  kind: "file" | "skill";
  title: string;
  path: string;
  meta?: { size?: number; lines?: number };
}

/** 内联类引用: 无路径可用, 内容带标记拼入消息 */
export interface InlineRef {
  kind: "session" | "clipboard-text";
  title: string;
  content: string;
}

/** 图像类引用: 发送时进 images 字段 (base64) */
export interface ImageRef {
  kind: "image" | "screenshot" | "clipboard-image";
  title: string;
  data: string;
  mimeType: string;
}

export type Ref = PathRef | InlineRef | ImageRef;

export interface SendParts {
  /** 附加在用户消息后的引用段 (含前置空行), 空串表示无文本引用 */
  textRefs: string;
  images: { type: "image"; data: string; mimeType: string }[];
}

/** refs → 发送载荷: 路径类拼标记行, 内联类拼标记+内容, 图像类收进 images */
export function buildRefsParts(refs: Ref[]): SendParts {
  const textLines: string[] = [];
  const images: SendParts["images"] = [];
  for (const r of refs) {
    if (r.kind === "file" || r.kind === "skill") {
      textLines.push(`[引用文件: ${r.path}]`);
    } else if (r.kind === "session") {
      textLines.push(`[引用会话: ${r.title}]\n${r.content}`);
    } else if (r.kind === "clipboard-text") {
      textLines.push(`[剪贴板内容]\n${r.content}`);
    } else if (r.kind === "image" || r.kind === "screenshot" || r.kind === "clipboard-image") {
      images.push({ type: "image", data: r.data, mimeType: r.mimeType });
    }
  }
  return {
    textRefs: textLines.length ? "\n\n" + textLines.join("\n\n") : "",
    images,
  };
}

/** chips 类型图标映射 (lucide 组件) */
import { FileText, MessageSquare, Clipboard, Camera, Sparkles, Image as ImageIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export function refIcon(r: Ref): LucideIcon {
  switch (r.kind) {
    case "file": return FileText;
    case "skill": return Sparkles;
    case "session": return MessageSquare;
    case "clipboard-text":
    case "clipboard-image": return Clipboard;
    case "screenshot": return Camera;
    case "image": return ImageIcon;
  }
}

/** chips 元信息小字: 大小/行数 → "12KB · 300行" */
export function refMetaText(r: Ref): string {
  if ((r.kind === "file" || r.kind === "skill") && r.meta) {
    const parts: string[] = [];
    if (r.meta.size !== undefined) {
      parts.push(r.meta.size >= 1024 * 1024
        ? `${(r.meta.size / 1024 / 1024).toFixed(1)}MB`
        : `${Math.max(1, Math.round(r.meta.size / 1024))}KB`);
    }
    if (r.meta.lines !== undefined) parts.push(`${r.meta.lines}行`);
    return parts.join(" · ");
  }
  return "";
}
