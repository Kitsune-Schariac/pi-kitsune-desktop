import { useEffect, useMemo } from "react";
import { ShieldAlert, Terminal, X } from "lucide-react";
import type { PermissionRequest } from "../lib/agent";
import { Button } from "./ui";

/**
 * 通用工具权限审批弹窗 (FIFO 队列队头):
 * 同时承接 Claude Code (`can_use_tool`) 与 ACP (`session/request_permission`)。
 * 遵循项目令牌体系 (4px 整档间距 / 纯 CSS 语义变量 / Esc 拒绝)。
 */
export function PermissionRequestModal({
  request,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest;
  onAllow: (id: string, optionId?: string) => void;
  onDeny: (id: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDeny(request.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request.id, onDeny]);

  const inputPreview = useMemo(() => {
    if (request.input === null || request.input === undefined) return "";
    if (typeof request.input === "string") return request.input;
    try {
      return JSON.stringify(request.input, null, 2);
    } catch {
      return String(request.input);
    }
  }, [request.input]);

  return (
    <div
      data-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDeny(request.id);
      }}
    >
      <div className="w-[480px] max-w-[92vw] rounded-xl border border-edge bg-popover shadow-lg view-in-soft">
        <div className="flex h-12 items-center gap-2 border-b border-line pl-5 pr-3">
          <ShieldAlert className="h-4 w-4 shrink-0 text-warn" />
          <span className="flex-1 truncate text-lead font-semibold text-fg">
            工具权限审批
          </span>
          <button
            onClick={() => onDeny(request.id)}
            className="grid h-8 w-8 place-items-center rounded-md text-fg-4 transition duration-fast ease-out hover:bg-hover hover:text-fg"
            title="拒绝 (Esc)"
            aria-label="拒绝"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="flex items-center gap-2 text-body">
            <Terminal className="h-4 w-4 shrink-0 text-fg-4" />
            <span className="font-mono font-medium text-fg">{request.toolName}</span>
          </div>
          {request.description && (
            <p className="text-body leading-relaxed text-fg-2">{request.description}</p>
          )}
          {inputPreview && (
            <pre className="max-h-56 overflow-auto rounded-md border border-line bg-well p-3 font-mono text-label leading-relaxed text-fg-2 whitespace-pre-wrap break-all">
              {inputPreview}
            </pre>
          )}

          {request.options.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="text-meta text-fg-4">快捷选项</div>
              <div className="flex flex-wrap gap-2">
                {request.options.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      const isReject = opt.kind.toLowerCase().includes("reject") || opt.kind.toLowerCase().includes("deny");
                      if (isReject) onDeny(request.id);
                      else onAllow(request.id, opt.id);
                    }}
                    className="rounded-md border border-edge bg-card px-3 py-1 text-label text-fg-2 shadow-sm transition duration-fast ease-out hover:border-line-2 hover:text-fg"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button onClick={() => onDeny(request.id)}>拒绝</Button>
          <Button variant="primary" onClick={() => onAllow(request.id)}>
            允许执行
          </Button>
        </div>
      </div>
    </div>
  );
}
