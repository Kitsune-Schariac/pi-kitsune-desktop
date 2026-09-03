import { useEffect, useRef, useState } from "react";
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
      <ShieldAlert className="h-5 w-5 text-primary-500" />
    ) : request.method === "select" ? (
      <ListChecks className="h-5 w-5 text-primary-500" />
    ) : request.method === "editor" ? (
      <FileText className="h-5 w-5 text-primary-500" />
    ) : (
      <TextCursorInput className="h-5 w-5 text-primary-500" />
    );

  const submit = () => onResolve(request.id, { value });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        // 点遮罩本身 = 取消 (不拦截卡片内部点击)
        if (e.target === e.currentTarget) onCancel(request.id);
      }}
    >
      <div className="w-[420px] max-w-[90vw] rounded-md border border-neutral-200 bg-panel shadow-lg">
        <div className="flex items-center gap-2 border-b border-neutral-200 px-5 py-4">
          {icon}
          <span className="flex-1 truncate text-body font-semibold text-neutral-800">
            {request.title || "扩展请求"}
          </span>
          <button
            onClick={() => onCancel(request.id)}
            className="rounded-md p-1 text-neutral-400 transition duration-fast ease-out hover:bg-neutral-100 hover:text-neutral-700"
            title="取消 (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          {request.method === "confirm" && (
            <p className="text-body leading-relaxed text-neutral-600">
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
                    className="flex w-full items-center justify-between rounded-md border border-neutral-200 px-4 py-2 text-left text-body text-neutral-700 transition duration-fast ease-out hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700"
                  >
                    <span className="truncate">{opt}</span>
                    <ListChecks className="h-4 w-4 shrink-0 text-neutral-300" />
                  </button>
                ))
              ) : (
                <p className="text-body text-neutral-400">没有可用选项</p>
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
              className="w-full rounded-md border border-neutral-200 px-3 py-2 text-body outline-none transition duration-fast ease-out focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
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
              className="w-full resize-y rounded-md border border-neutral-200 px-3 py-2 font-mono text-body outline-none transition duration-fast ease-out focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
            />
          )}
        </div>

        {(request.method === "confirm" || request.method === "input" || request.method === "editor") && (
          <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-4">
            <button
              onClick={() => onCancel(request.id)}
              className="rounded-md px-4 py-2 text-body text-neutral-600 transition duration-fast ease-out hover:bg-neutral-100 hover:text-neutral-800"
            >
              取消
            </button>
            <button
              onClick={request.method === "confirm" ? () => onResolve(request.id, { confirmed: true }) : submit}
              className="rounded-md bg-primary-500 px-4 py-2 text-body font-medium text-white transition duration-fast ease-out hover:bg-primary-600"
            >
              {request.method === "confirm" ? "确认" : "提交"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// notify 通知条: 右下角堆叠, 自动消失 (info/warning/error 三态)
export function NotificationToasts({
  notifications,
  onDismiss,
}: {
  notifications: { id: string; message: string; notifyType: "info" | "warning" | "error" }[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="fixed bottom-6 right-6 z-40 flex w-[320px] flex-col gap-2">
      {notifications.map((n) => (
        <NotificationToast key={n.id} n={n} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function NotificationToast({
  n,
  onDismiss,
}: {
  n: { id: string; message: string; notifyType: "info" | "warning" | "error" };
  onDismiss: (id: string) => void;
}) {
  // 3.5s 自动消失; 卸载时清理定时器
  useEffect(() => {
    const t = setTimeout(() => onDismiss(n.id), 3500);
    return () => clearTimeout(t);
  }, [n.id, onDismiss]);

  const style =
    n.notifyType === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : n.notifyType === "warning"
        ? "border-primary-200 bg-primary-50 text-primary-700"
        : "border-neutral-200 bg-panel text-neutral-700";
  const Icon =
    n.notifyType === "error" ? XCircle : n.notifyType === "warning" ? AlertTriangle : Info;

  return (
    <div className={`flex items-start gap-2 rounded-md border px-4 py-2 shadow-lg ${style}`}>
      <Icon className="mt-1 h-4 w-4 shrink-0" />
      <span className="flex-1 break-words text-body leading-snug">{n.message}</span>
      <button
        onClick={() => onDismiss(n.id)}
        className="shrink-0 rounded-sm p-1 opacity-50 transition duration-fast ease-out hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
