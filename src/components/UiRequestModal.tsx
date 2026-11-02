import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  Info,
  ListChecks,
  ShieldAlert,
  TextCursorInput,
  X,
  XCircle,
} from "lucide-react";
import type { UiRequest } from "../lib/pi";
import { Button, FIELD_BASE } from "./ui";

// 扩展 UI 请求弹窗: 权限确认 (confirm) / 选项 (select) / 单行输入 (input) / 多行文本 (editor)
// 回复协议: confirm → {confirmed} ; select/input/editor → {value} ; 取消 → {cancelled: true}
export function UiRequestModal({
  request,
  onResolve,
  onCancel,
}: {
  request: UiRequest;
  onResolve: (id: string, payload: { confirmed?: boolean; value?: string }) => void;
  onCancel: (id: string) => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 队列切到下一个请求时重置本地文本 (组件复用, 不清会残留上一个请求的输入)
  useEffect(() => {
    setValue(request.prefill ?? "");
  }, [request.id, request.prefill]);

  // Esc = 取消 (id 变化时重绑, 队列切换后监听的是当前请求)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel(request.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request.id, onCancel]);

  // input 自动聚焦; editor 大段预填时聚焦末尾 (便于直接追加)
  useEffect(() => {
    if (request.method === "input") {
      inputRef.current?.focus();
    } else if (request.method === "editor") {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
  }, [request.id, request.method]);

  const icon =
    request.method === "confirm" ? (
      <ShieldAlert className="h-4 w-4 text-fg-3" />
    ) : request.method === "select" ? (
      <ListChecks className="h-4 w-4 text-fg-3" />
    ) : request.method === "editor" ? (
      <FileText className="h-4 w-4 text-fg-3" />
    ) : (
      <TextCursorInput className="h-4 w-4 text-fg-3" />
    );

  const submit = () => onResolve(request.id, { value });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        // 点遮罩本身 = 取消 (不拦截卡片内部点击)
        if (e.target === e.currentTarget) onCancel(request.id);
      }}
    >
      <div className="w-[440px] max-w-[90vw] rounded-xl border border-edge bg-popover shadow-lg view-in-soft">
        <div className="flex h-12 items-center gap-2 border-b border-line pl-5 pr-3">
          {icon}
          <span className="flex-1 truncate text-lead font-semibold text-fg">
            {request.title || "扩展请求"}
          </span>
          <button
            onClick={() => onCancel(request.id)}
            className="grid h-8 w-8 place-items-center rounded-md text-fg-4 transition duration-fast ease-out hover:bg-hover hover:text-fg"
            title="取消 (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-5">
          {request.method === "confirm" && (
            <p className="text-body leading-relaxed text-fg-2">
              {request.message || "请确认此操作"}
            </p>
          )}

          {request.method === "select" && (
            <div className="space-y-2">
              {request.options?.length ? (
                request.options.map((opt) => (
                  <button
                    key={opt}
                    onClick={() => onResolve(request.id, { value: opt })}
                    className="flex h-10 w-full items-center justify-between rounded-md border border-edge bg-card px-4 text-left text-body text-fg-2 shadow-sm transition duration-fast ease-out hover:border-line-2 hover:text-fg"
                  >
                    <span className="truncate">{opt}</span>
                    <ListChecks className="h-4 w-4 shrink-0 text-fg-4" />
                  </button>
                ))
              ) : (
                <p className="text-body text-fg-4">没有可用选项</p>
              )}
            </div>
          )}

          {request.method === "input" && (
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder={request.placeholder || "输入内容…"}
              className={`${FIELD_BASE} h-9 px-3`}
            />
          )}

          {request.method === "editor" && (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl+Enter 提交 (普通 Enter 换行, 不误提交多行编辑)
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
              }}
              rows={8}
              className={`${FIELD_BASE} resize-y px-3 py-2 font-mono leading-relaxed`}
            />
          )}
        </div>

        {(request.method === "confirm" || request.method === "input" || request.method === "editor") && (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
            <Button onClick={() => onCancel(request.id)}>取消</Button>
            <Button
              variant="primary"
              onClick={request.method === "confirm" ? () => onResolve(request.id, { confirmed: true }) : submit}
            >
              {request.method === "confirm" ? "确认" : "提交"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// notify 通知条: 主区右上 (StageHead 下方) 堆叠, 自动消失 (info/warning/error 三态)
// 位置选右上而非输入卡上方: 输入卡上方是 steer 队列浮层的地盘, 贴主区顶部不与其争位
const TOAST_TTL = 3500;
/** 同屏最多展示的通知组数, 多出的折叠为「还有 N 条」 (防通知刷屏遮住正文) */
const MAX_VISIBLE_GROUPS = 3;

type ToastNotification = { id: string; message: string; notifyType: "info" | "warning" | "error" };

interface NotificationGroup {
  key: string;
  message: string;
  notifyType: ToastNotification["notifyType"];
  /** 组内全部成员: 关闭与自动消失都要按组操作, 只 dismiss 一条会让 ×N 计数错乱 */
  items: ToastNotification[];
}

// 同文 (message + notifyType) 归为一组: 扩展连续 notify 同一句话时不再堆叠多张卡片。
// 数据与 store 逻辑不动, 合并只做在渲染层
function groupNotifications(notifications: ToastNotification[]): NotificationGroup[] {
  const map = new Map<string, NotificationGroup>();
  for (const n of notifications) {
    // \u0000 分隔两段: message 可含任意字符, 防止拼接出跨组碰撞
    const key = `${n.notifyType}\u0000${n.message}`;
    const hit = map.get(key);
    if (hit) hit.items.push(n);
    else map.set(key, { key, message: n.message, notifyType: n.notifyType, items: [n] });
  }
  // Map 迭代 = 组首次出现顺序
  return [...map.values()];
}

/** 类型色: info 走 --fg-3 (不抢眼), warning/error 走状态色 */
function notificationTone(t: ToastNotification["notifyType"]): string {
  return t === "error" ? "var(--err)" : t === "warning" ? "var(--warn)" : "var(--fg-3)";
}

export function NotificationToasts({
  notifications,
  onDismiss,
}: {
  notifications: ToastNotification[];
  onDismiss: (id: string) => void;
}) {
  const groups = useMemo(() => groupNotifications(notifications), [notifications]);
  // 展示最新的几组: 刚发生的消息优先可见; 更早的组仍在独立计时, 到期后自动消失并递补
  const hidden = Math.max(0, groups.length - MAX_VISIBLE_GROUPS);
  const visible = hidden > 0 ? groups.slice(hidden) : groups;

  return (
    <div
      className="pointer-events-none absolute right-4 top-16 z-40 flex w-[340px] max-w-[calc(100%-32px)] flex-col gap-2"
    >
      {/* 计时器与卡片分离: 折叠未渲染的组也要按时到期, 否则数据会永远留在 store 里 */}
      {groups.map((g) => (
        <GroupTimer key={g.key} group={g} onDismiss={onDismiss} />
      ))}
      {hidden > 0 && (
        <div className="pointer-events-auto self-end rounded-full border border-edge bg-popover px-3 py-1 text-meta text-fg-3 shadow-lg">
          还有 {hidden} 条通知
        </div>
      )}
      {visible.map((g) => (
        <NotificationToast key={g.key} group={g} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/** 每组的自动消失计时 (以组内最新一条为准); 不渲染 UI */
function GroupTimer({ group, onDismiss }: { group: NotificationGroup; onDismiss: (id: string) => void }) {
  // 组内 id 串作依赖: 同文重复到达 (新成员入组) 时重置计时, 让用户多看一眼
  const sig = group.items.map((n) => n.id).join("|");
  useEffect(() => {
    const t = setTimeout(() => {
      group.items.forEach((n) => onDismiss(n.id));
    }, TOAST_TTL);
    return () => clearTimeout(t);
    // group 每次渲染重建, 不能进依赖; sig 变化时本 effect 重跑, 闭包拿到的是当次快照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, onDismiss]);
  return null;
}

function NotificationToast({
  group,
  onDismiss,
}: {
  group: NotificationGroup;
  onDismiss: (id: string) => void;
}) {
  const { notifyType, message, items } = group;
  const tone = notificationTone(notifyType);
  const Icon = notifyType === "error" ? XCircle : notifyType === "warning" ? AlertTriangle : Info;

  return (
    <div
      className="pointer-events-auto flex items-start gap-3 rounded-lg border border-edge bg-popover px-4 py-3 shadow-lg view-in-soft"
    >
      <Icon className="mt-[3px] h-4 w-4 shrink-0" style={{ color: tone }} />
      <span className="flex-1 break-words text-body leading-snug text-fg-2">
        {message}
        {items.length > 1 && <span className="ml-1 text-meta text-fg-4">×{items.length}</span>}
      </span>
      <button
        onClick={() => items.forEach((n) => onDismiss(n.id))}
        className="-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-4 transition duration-fast ease-out hover:bg-hover hover:text-fg"
        title="关闭"
        aria-label="关闭通知"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
