import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/session";
import {
  Send, Square, Paperclip, X, ChevronDown, Cpu, Layers, Brain, Loader2,
} from "lucide-react";
import { buildRefsParts, refIcon, refMetaText, type Ref } from "../lib/refs";
import { RefsPopup } from "./refs/RefsPopup";

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
  const [refs, setRefs] = useState<Ref[]>([]);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [preview, setPreview] = useState<{ ref: Ref; content: string | null; loading: boolean } | null>(null);
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
  const sendSteer = useSessionStore((s) => s.sendSteer);
  const sendFollowUp = useSessionStore((s) => s.sendFollowUp);
  const abort = useSessionStore((s) => s.abort);
  const startSession = useSessionStore((s) => s.startSession);

  const providers = useMemo(
    () => [...new Set(availableModels.map((m) => m.provider))],
    [availableModels]
  );
  const selProvider = currentModel?.provider ?? providers[0] ?? "";
  const providerModels = availableModels.filter((m) => m.provider === selProvider);

  // 引用文件: 图片 → base64 (走 pi images 字段); 文本 → 只留路径+元信息 (路径模式, 内容不进上下文)
  // chips 点击预览: 文件类异步读内容 (仅预览用, 不随消息发送); 内联/图像类直接用内存数据
  const openPreview = async (r: Ref) => {
    setPreview({ ref: r, content: null, loading: true });
    if (r.kind === "file" || r.kind === "skill") {
      try {
        const res = await invoke<{ content: string }>("read_file_for_context", { filePath: r.path });
        setPreview({ ref: r, content: res.content, loading: false });
      } catch (e) {
        setPreview({ ref: r, content: `读取失败: ${e}`, loading: false });
      }
    } else if (r.kind === "session" || r.kind === "clipboard-text") {
      setPreview({ ref: r, content: r.content, loading: false });
    } else {
      setPreview({ ref: r, content: null, loading: false });
    }
  };

  // 三种发送模式共用组装逻辑: prompt (普通对话) / steer (运行中指导) / followUp (排队后续)
  // steer/followUp 必须已有活跃会话 (队列是会话级状态), 只有 prompt 支持空状态自动建会话
  const handleSend = async (mode: "prompt" | "steer" | "followUp" = "prompt") => {
    if (!text.trim()) return;
    if (!activeSessionId) {
      if (mode !== "prompt") {
        setHint("请先打开一个会话再发送");
        setTimeout(() => setHint(null), 2500);
        return;
      }
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
    // 组装发送载荷: 路径类引用 → [引用文件: path] 标记段; 内联类 → 标记+内容; 图像 → images 字段
    const parts = buildRefsParts(refs);
    const full = text.trim() + parts.textRefs;
    const images = parts.images.length ? parts.images : undefined;
    if (mode === "steer") await sendSteer(activeSessionId!, full, images);
    else if (mode === "followUp") await sendFollowUp(activeSessionId!, full, images);
    else await sendPrompt(activeSessionId!, full, images);
    setText("");
    setRefs([]);
    textareaRef.current?.focus();
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // 对齐 pi TUI 官方行为: 运行中 Alt+Enter 排队 followUp, 空闲时 Alt+Enter 与 Enter 等价直接发送
      // (pi 的 followUp 队列只在下一次 turn 时投递, 空闲排队会造成消息悬挂不投递)
      if (isStreaming) handleSend(e.altKey ? "followUp" : "steer");
      else handleSend("prompt");
    }
  };

  const percent = contextUsage?.percent ?? null;
  const cuText = contextUsage
    ? `${Math.round((contextUsage.tokens ?? 0) / 1000)}k / ${Math.round(contextUsage.contextWindow / 1000)}k`
    : null;

  return (
    // 悬浮输入卡: 底部居中, 宽度与消息列表一致 (max-w-[65%]), 与消息区分离成浮动层
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 mx-auto w-full max-w-[65%] px-4">
      <div
        ref={cardRef}
        // 半透明悬浮卡: 消息从卡片后方滑过时可见 (不挡内容), 轻模糊防文字混叠
        className="pointer-events-auto rounded-2xl border border-neutral-200 bg-white/80 shadow-[0_-2px_20px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.10)] backdrop-blur-[2px] transition focus-within:border-orange-400"
      >
        <div className="px-4 pt-3">
          {/* 引用 chips: 类型图标 + 标题 + 元信息, 点击预览, × 移除 */}
          {refs.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {refs.map((r, i) => {
                const Icon = refIcon(r);
                const meta = refMetaText(r);
                return (
                  <span
                    key={i}
                    className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-2 py-1 text-xs text-orange-700"
                  >
                    <Icon className="h-3 w-3" />
                    <button
                      onClick={() => openPreview(r)}
                      className="max-w-[180px] truncate hover:underline"
                      title="点击预览"
                    >
                      {r.title}
                    </button>
                    {meta && <span className="text-[10px] text-orange-400">{meta}</span>}
                    <button
                      onClick={() => setRefs((prev) => prev.filter((_, j) => j !== i))}
                      className="rounded p-0.5 transition hover:bg-orange-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {/* 引用预览 popover */}
          {preview && (
            <div className="relative">
              <div className="absolute bottom-full left-0 z-50 mb-1 w-[420px] rounded-xl border border-neutral-200 bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-700">
                    {(() => {
                      const Icon = refIcon(preview.ref);
                      return <Icon className="h-3.5 w-3.5 text-orange-500" />;
                    })()}
                    {preview.ref.title}
                  </span>
                  <button
                    onClick={() => setPreview(null)}
                    className="rounded p-1 text-neutral-400 transition hover:bg-neutral-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="max-h-64 overflow-auto p-3">
                  {preview.loading ? (
                    <div className="flex items-center gap-2 text-xs text-neutral-400">
                      <Loader2 className="h-4 w-4 animate-spin" /> 加载预览…
                    </div>
                  ) : preview.ref.kind === "image" ||
                    preview.ref.kind === "screenshot" ||
                    preview.ref.kind === "clipboard-image" ? (
                    <img
                      src={`data:${preview.ref.mimeType};base64,${preview.ref.data}`}
                      alt={preview.ref.title}
                      className="max-h-56 rounded-lg border border-neutral-100"
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-600">
                      {preview.content ?? ""}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder={isStreaming ? "运行中: Enter 发 steer 指导, Alt+Enter 排队后续" : "输入消息, Enter 发送"}
          rows={2}
          className="max-h-[256px] w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-3 text-sm text-neutral-800 outline-none placeholder:text-neutral-500"
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
              <RefsPopup
                root={active?.cwd || emptyProject}
                onPick={(rs) => setRefs((prev) => [...prev, ...rs])}
                onClose={() => setCtxOpen(false)}
              />
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
                title="中止 (Enter 发 steer 指导)"
              >
                <Square className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={() => handleSend("prompt")}
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
