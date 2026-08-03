import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/session";
import {
  Send, Square, Paperclip, FileText, Image as ImageIcon,
  X, ChevronDown, Cpu, Layers, Brain,
} from "lucide-react";

interface FileRef {
  kind: "image" | "text";
  fileName: string;
  data?: string;
  mimeType?: string;
  content?: string;
}

// 紧凑下拉 (provider/model/thinking 共用)
function MiniSelect({ label, icon: Icon, value, options, onChange, disabled }: {
  label: string;
  icon: typeof Cpu;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [openSel, setOpenSel] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpenSel(!openSel)}
        disabled={disabled}
        className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40"
        title={label}
      >
        <Icon className="h-3 w-3 text-neutral-400" />
        <span className="max-w-[90px] truncate">{value}</span>
        <ChevronDown className="h-2.5 w-2.5 text-neutral-400" />
      </button>
      {openSel && (
        <div className="absolute bottom-full right-0 z-50 mb-1 max-h-56 overflow-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-xl">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => { onChange(opt); setOpenSel(false); }}
              className={`block w-full whitespace-nowrap px-3 py-1.5 text-left text-xs transition hover:bg-neutral-100 ${
                opt === value ? "text-orange-600" : "text-neutral-600"
              }`}
            >
              {opt}
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-400">无选项</div>
          )}
        </div>
      )}
    </div>
  );
}

// textarea 自动增高的最大高度: 12 行 × 行高 20px + 垂直 padding 16px
const TEXTAREA_MAX_HEIGHT = 12 * 20 + 16;

export function InputBar({
  emptyProject,
  onHeightChange,
}: {
  emptyProject: string;
  // 卡片实际高度变化时回调 (App 据此调整消息区底部留白, 避免高输入框遮挡消息)
  onHeightChange?: (h: number) => void;
}) {
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<FileRef[]>([]);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // textarea 自动增高: 内容超过 rows 高度时拉高, 上限 12 行 (超出后内部滚动)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!text) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  }, [text]);

  // 卡片高度变化时上报, 让 App 动态调整消息区底部留白
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    onHeightChange?.(el.offsetHeight);
    const ro = new ResizeObserver(() => onHeightChange?.(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeightChange]);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const active = activeSessionId ? sessions[activeSessionId] : null;
  const isStreaming = active?.isStreaming ?? false;
  const contextUsage = active?.contextUsage ?? null;
  const currentModel = active?.currentModel ?? null;
  const availableModels = active?.availableModels ?? [];
  const thinkingLevel = active?.thinkingLevel ?? "medium";
  const availableThinkingLevels = active?.availableThinkingLevels ?? ["off"];
  const setModel = useSessionStore((s) => s.setModel);
  const setThinkingLevel = useSessionStore((s) => s.setThinkingLevel);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const abort = useSessionStore((s) => s.abort);
  const startSession = useSessionStore((s) => s.startSession);

  const providers = useMemo(
    () => [...new Set(availableModels.map((m) => m.provider))],
    [availableModels]
  );
  const selProvider = currentModel?.provider ?? providers[0] ?? "";
  const providerModels = availableModels.filter((m) => m.provider === selProvider);

  // 引用文件: 图片 → base64 (走 pi images 字段), 文本 → 内容拼进消息
  const handleAddFile = async () => {
    try {
      const sel = await open({ multiple: false, title: "引用文件" });
      if (!sel || typeof sel !== "string") return;
      const res = await invoke<FileRef>("read_file_for_context", { filePath: sel });
      setRefs((prev) => [...prev, res]);
    } catch (e) {
      console.error("引用文件失败", e);
    }
  };

  const handleSend = async () => {
    if (!text.trim() || isStreaming) return;
    // 无选中会话: 空状态流程 → 用已选项目自动建会话再发
    if (!activeSessionId) {
      if (!emptyProject) {
        setHint("请先在上方选择项目");
        setTimeout(() => setHint(null), 2500);
        return;
      }
      try {
        await startSession(emptyProject);
      } catch (e) {
        console.error("自动新建会话失败", e);
        return;
      }
    }
    const images = refs
      .filter((r): r is FileRef & { data: string; mimeType: string } => r.kind === "image" && !!r.data)
      .map((r) => ({ type: "image", data: r.data, mimeType: r.mimeType }));
    // 文本引用: 附加到消息末尾
    const textRefs = refs.filter((r) => r.kind === "text" && r.content);
    const extra = textRefs.length
      ? "\n\n" + textRefs.map((r) => `[引用文件: ${r.fileName}]\n${r.content}`).join("\n\n")
      : "";
    await sendPrompt(activeSessionId!, text.trim() + extra, images.length ? images : undefined);
    setText("");
    setRefs([]);
    textareaRef.current?.focus();
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const percent = contextUsage?.percent ?? null;
  const cuText = contextUsage
    ? `${Math.round((contextUsage.tokens ?? 0) / 1000)}k / ${Math.round(contextUsage.contextWindow / 1000)}k`
    : null;

  return (
    // 悬浮输入卡: 底部居中, 宽度与消息列表一致 (max-w-[70%]), 与消息区分离成浮动层
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 mx-auto w-full max-w-[70%] px-4">
      <div
        ref={cardRef}
        className="pointer-events-auto rounded-2xl border border-neutral-200 bg-white/95 shadow-[0_-2px_20px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.10)] backdrop-blur-sm transition focus-within:border-orange-400"
      >
        <div className="px-4 pt-3">
          {/* 引用文件 chips */}
          {refs.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
          {refs.map((r, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-2 py-1 text-xs text-orange-700"
            >
              {r.kind === "image" ? (
                <ImageIcon className="h-3 w-3" />
              ) : (
                <FileText className="h-3 w-3" />
              )}
              <span className="max-w-[180px] truncate">{r.fileName}</span>
              <button
                onClick={() => setRefs((prev) => prev.filter((_, j) => j !== i))}
                className="rounded p-0.5 transition hover:bg-orange-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder={isStreaming ? "等待回复…" : "输入消息, Enter 发送"}
          disabled={isStreaming}
          rows={2}
          className="max-h-[256px] w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-3 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 disabled:opacity-60"
        />

        {/* 输入框内底部工具行: 左上下文 / 右 context window + 选择器 + 发送 */}
        {hint && <p className="px-4 text-right text-xs text-orange-600">{hint}</p>}
        <div className="flex items-center justify-between px-2 pb-2">
          {/* 左下: 上下文添加 */}
          <div className="relative">
            <button
              onClick={() => setCtxOpen(!ctxOpen)}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700"
              title="添加上下文"
            >
              <Paperclip className="h-3.5 w-3.5" />
              上下文
            </button>
            {ctxOpen && (
              <div className="absolute bottom-full left-0 z-50 mb-1 w-44 rounded-lg border border-neutral-200 bg-white py-1 shadow-xl">
                <button
                  onClick={() => { handleAddFile(); setCtxOpen(false); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-600 transition hover:bg-neutral-100"
                >
                  <FileText className="h-3.5 w-3.5 text-neutral-400" />
                  引用文件
                </button>
                <div className="px-3 py-1.5 text-[10px] text-neutral-300">
                  图片/文本均可, 随消息发送
                </div>
              </div>
            )}
          </div>

          {/* 右下: context window + provider/model/thinking + 发送 */}
          <div className="flex items-center gap-2">
            {/* context window 使用情况 */}
            <div
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition hover:bg-neutral-100"
              title={cuText ? `上下文 ${cuText} tokens` : "暂无上下文统计"}
            >
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200">
                <div
                  className={`h-full rounded-full transition-all ${
                    percent === null ? "bg-neutral-300" : percent > 85 ? "bg-red-500" : "bg-orange-500"
                  }`}
                  style={{ width: percent === null ? "0%" : `${Math.min(100, percent)}%` }}
                />
              </div>
              <span className="text-[10px] tabular-nums text-neutral-400">
                {percent === null ? "--" : `${Math.round(percent)}%`}
              </span>
            </div>

            <MiniSelect
              label="Provider"
              icon={Layers}
              value={selProvider || "Provider"}
              options={providers}
              onChange={(p) => {
                const m = availableModels.find((mm) => mm.provider === p);
                if (activeSessionId && m) setModel(activeSessionId, p, m.id);
              }}
              disabled={!activeSessionId || providers.length === 0}
            />
            <MiniSelect
              label="Model"
              icon={Cpu}
              value={currentModel?.name ?? "Model"}
              options={providerModels.map((m) => m.name)}
              onChange={(name) => {
                const m = providerModels.find((mm) => mm.name === name);
                if (activeSessionId && m) setModel(activeSessionId, selProvider, m.id);
              }}
              disabled={!activeSessionId || providerModels.length === 0}
            />
            <MiniSelect
              label="Thinking"
              icon={Brain}
              value={thinkingLevel}
              options={availableThinkingLevels}
              onChange={(lv) => activeSessionId && setThinkingLevel(activeSessionId, lv)}
              disabled={!activeSessionId || availableThinkingLevels.length <= 1}
            />

            {isStreaming ? (
              <button
                onClick={() => activeSessionId && abort(activeSessionId)}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-100 text-red-500 transition hover:bg-red-200"
                title="中止"
              >
                <Square className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!text.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-500 text-white shadow-sm shadow-orange-500/30 transition hover:bg-orange-600 disabled:opacity-40"
                title="发送"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
