import { useState } from "react";
import { MessageSquarePlus, ListPlus } from "lucide-react";

/**
 * steer/followUp 队列指示: header 上的计数徽标, 点击展开分组消息列表
 * 队列内容由 pi queue_update 事件权威回推 (store steeringQueue/followUpQueue)
 */
export function QueueIndicator({ steering, followUp }: { steering: string[]; followUp: string[] }) {
  const [open, setOpen] = useState(false);
  const total = steering.length + followUp.length;
  // 无队列不渲染 (hooks 已声明完毕, 条件 return 安全)
  if (total === 0) return null;

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition hover:bg-neutral-100"
        title={`待处理队列 ${total} 条: steer ${steering.length} / followUp ${followUp.length}`}
      >
        {steering.length > 0 && (
          <span className="flex items-center gap-0.5 rounded bg-orange-100 px-1.5 py-0.5 font-medium text-orange-600">
            <MessageSquarePlus className="h-3 w-3" />
            {steering.length}
          </span>
        )}
        {followUp.length > 0 && (
          <span className="flex items-center gap-0.5 rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-600">
            <ListPlus className="h-3 w-3" />
            {followUp.length}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* 透明遮罩: 点击任意处关闭 (与 SettingsWindow 遮罩同模式) */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 max-h-72 w-80 overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-xl">
            <QueueGroup label="steer 指导" color="orange" icon={<MessageSquarePlus className="h-3 w-3" />} items={steering} />
            <QueueGroup label="followUp 后续" color="blue" icon={<ListPlus className="h-3 w-3" />} items={followUp} />
            {total === 0 && <div className="px-4 py-3 text-xs text-neutral-400">队列为空</div>}
          </div>
        </>
      )}
    </div>
  );
}

function QueueGroup({ label, color, icon, items }: {
  label: string;
  color: "orange" | "blue";
  icon: React.ReactNode;
  items: string[];
}) {
  if (items.length === 0) return null;
  const labelCls = color === "orange" ? "text-orange-600" : "text-blue-600";
  return (
    <div className="py-1">
      <div className={`flex items-center gap-1 px-4 py-1 text-[10px] font-medium uppercase tracking-wide ${labelCls}`}>
        {icon}
        {label}
        <span className="text-neutral-300">{items.length}</span>
      </div>
      {items.map((msg, i) => (
        <div key={i} className="border-l-2 border-neutral-100 px-4 py-1 text-xs text-neutral-600">
          <p className="truncate" title={msg}>{msg}</p>
        </div>
      ))}
    </div>
  );
}
