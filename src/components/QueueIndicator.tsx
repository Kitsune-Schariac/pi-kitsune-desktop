import { useState } from "react";
import { ChevronDown, ListPlus, MessageSquarePlus } from "lucide-react";

/**
 * steer/followUp 队列指示 (挂在输入卡上沿): 「待发送：steer N · 后续 M」整行计数条,
 * 点击展开分组消息列表 (列表向输入卡上方浮出, 不挤压输入区)。
 * 队列内容由 pi queue_update 事件权威回推 (store steeringQueue/followUpQueue), 与旧头部徽标同一数据流。
 */
export function QueueIndicator({ steering, followUp }: { steering: string[]; followUp: string[] }) {
  const [open, setOpen] = useState(false);
  const total = steering.length + followUp.length;
  // 无队列不渲染 (hooks 已声明完毕, 条件 return 安全)
  if (total === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="queue-bar"
        title={`待处理队列 ${total} 条: steer ${steering.length} / followUp ${followUp.length}`}
        aria-expanded={open}
      >
        <MessageSquarePlus className="h-[14px] w-[14px] shrink-0 text-accent" />
        <span>待发送：</span>
        {steering.length > 0 && <span className="text-accent">steer {steering.length}</span>}
        {steering.length > 0 && followUp.length > 0 && <span className="text-fg-4">·</span>}
        {followUp.length > 0 && <span className="text-accent-2">后续 {followUp.length}</span>}
        <ChevronDown
          className={`ml-auto h-[14px] w-[14px] shrink-0 text-fg-4 transition-transform duration-base ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <>
          {/* 透明遮罩: 点击任意处关闭 (与其它弹层同模式) */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-80 max-w-[90vw] overflow-y-auto rounded-lg border border-line bg-raise py-1 shadow-[var(--shadow)]">
            <QueueGroup
              label="steer 指导"
              tone="accent"
              icon={<MessageSquarePlus className="h-3 w-3" />}
              items={steering}
            />
            <QueueGroup
              label="followUp 后续"
              tone="accent-2"
              icon={<ListPlus className="h-3 w-3" />}
              items={followUp}
            />
          </div>
        </>
      )}
    </div>
  );
}

function QueueGroup({ label, tone, icon, items }: {
  label: string;
  tone: "accent" | "accent-2";
  icon: React.ReactNode;
  items: string[];
}) {
  if (items.length === 0) return null;
  const labelCls = tone === "accent" ? "text-accent" : "text-accent-2";
  return (
    <div className="py-1">
      <div className={`flex items-center gap-1 px-4 py-1 text-mini font-medium ${labelCls}`}>
        {icon}
        {label}
        <span className="text-fg-4">{items.length}</span>
      </div>
      {items.map((msg, i) => (
        <div key={i} className="border-l-2 border-line px-4 py-1 text-mini text-fg-2">
          <p className="truncate" title={msg}>{msg}</p>
        </div>
      ))}
    </div>
  );
}
