import { memo } from "react";
import { AlertTriangle, Info, XCircle } from "lucide-react";
import type { ChatEntry } from "../store/session";

// 会话内通知条目: 居中系统消息形态, 不自动消失 (作为记录保留在消息流), 不持久化
// 配色: 底色/文字用 neutral-* 变量 (双主题自动适配), 类型色用固定 red/amber/neutral 500 色做左边框+图标
// (浅色暗色都可见, 不依赖 dark: 修饰符 — 项目暗色走 data-base 属性, 非 tailwind dark: 模式)
export const NotificationItem = memo(function NotificationItem({ entry }: { entry: ChatEntry }) {
  const t = entry.notifyType ?? "info";
  const Icon = t === "error" ? XCircle : t === "warning" ? AlertTriangle : Info;
  const border = t === "error" ? "border-l-red-500" : t === "warning" ? "border-l-amber-500" : "border-l-neutral-400";
  const iconColor = t === "error" ? "text-red-500" : t === "warning" ? "text-amber-500" : "text-neutral-400";
  return (
    <div className="flex justify-center">
      <div
        className={`flex max-w-[85%] items-start gap-2.5 rounded-lg border-l-4 ${border} bg-neutral-100/60 px-3.5 py-2.5 text-sm leading-snug text-neutral-700`}
      >
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconColor}`} />
        <span className="break-words">{entry.text}</span>
      </div>
    </div>
  );
});