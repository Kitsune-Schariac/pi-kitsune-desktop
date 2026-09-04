import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/session";
import type { ModelInfo } from "../store/session";
import {
  Send, Square, Paperclip, X, ChevronDown, Cpu, Brain, Loader2,
  ArrowUp, ArrowDown, Clock, DollarSign, Gauge,
} from "lucide-react";
import { buildRefsParts, refIcon, refMetaText, type Ref } from "../lib/refs";
import type { PaletteCommand } from "../lib/commands";
import type { PathRef } from "../lib/refs";
import { RefsPopup } from "./refs/RefsPopup";
import { MentionPopup, type MentionPopupHandle } from "./refs/MentionPopup";
import { CommandPalette, type CommandPaletteHandle } from "./CommandPalette";

// 紧凑下拉 (provider/model/thinking 共用)
function MiniSelect({ label, icon: Icon, value, options, onChange, disabled, openRef }: {
  label: string;
  icon: typeof Cpu;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
  // /model /thinking 命令的展开入口: 外部持有函数 ref, 调用即展开下拉
  openRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const [openSel, setOpenSel] = useState(false);
  // 同步最新展开函数, 卸载时置空防悬挂调用
  useEffect(() => {
    if (openRef) openRef.current = () => setOpenSel(true);
    return () => { if (openRef) openRef.current = null; };
  }, [openRef]);
  return (
    <div className="relative">
      <button
        onClick={() => setOpenSel(!openSel)}
        disabled={disabled}
        className="flex items-center gap-1 rounded-md px-2 py-2 text-label text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] disabled:opacity-40"
        title={label}
      >
        <Icon className="h-3 w-3 text-[var(--faint)]" />
        <span className="max-w-[90px] truncate">{value}</span>
        <ChevronDown className="h-2 w-2 text-[var(--faint)]" />
      </button>
      {openSel && (
        <div className="absolute bottom-full right-0 z-50 mb-1 max-h-56 overflow-auto rounded-md border border-[var(--border-soft)] bg-[var(--panel)] py-1 shadow-lg">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => { onChange(opt); setOpenSel(false); }}
              className={`block w-full whitespace-nowrap px-3 py-2 text-left text-label transition duration-fast ease-out hover:bg-[var(--surface-2)] ${
                opt === value ? "text-[var(--accent)]" : "text-[var(--muted)]"
              }`}
            >
              {opt}
            </button>
          ))}
          {options.length === 0 && (
            <div className="px-3 py-2 text-label text-[var(--faint)]">无选项</div>
          )}
        </div>
      )}
    </div>
  );
}

// 模型选择 (provider + model 合并为一个控件, 对齐设计稿 model-select):
// 按钮上同时显示 provider 与 model; 弹层顶部 provider chips 横排, 下方列当前 provider 的模型。
// 切 provider = 选中该 provider 的第一个模型; 点模型 = 切模型。openRef 供 /model 命令展开。
function ModelPicker({
  provider,
  model,
  models,
  onPick,
  disabled,
  openRef,
}: {
  provider: string;
  model: ModelInfo | null;
  /** 全部可选模型 (含 provider 字段), 组件内按 provider 分组 */
  models: ModelInfo[];
  onPick: (provider: string, modelId: string) => void;
  disabled?: boolean;
  openRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const [openSel, setOpenSel] = useState(false);
  useEffect(() => {
    if (openRef) openRef.current = () => setOpenSel(true);
    return () => { if (openRef) openRef.current = null; };
  }, [openRef]);

  // 按 provider 分组 (保持出现顺序)
  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    return [...map.entries()];
  }, [models]);
  const providerList = groups.map(([p]) => p);

  return (
    <div className="relative">
      <button
        onClick={() => setOpenSel(!openSel)}
        disabled={disabled}
        className="flex items-center gap-1 rounded-md px-2 py-2 text-label text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] disabled:opacity-40"
        title="切换模型与供应商"
      >
        <Cpu className="h-3 w-3 text-[var(--faint)]" />
        {model ? (
          <span className="max-w-[150px] truncate font-mono text-mini text-[var(--fg)]">
            {model.name}
          </span>
        ) : (
          <span className="text-[var(--faint)]">选择模型</span>
        )}
        <ChevronDown className="h-2 w-2 text-[var(--faint)]" />
      </button>
      {openSel && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-80 overflow-hidden rounded-md border border-[var(--border-soft)] bg-[var(--panel)] shadow-lg">
          {/* provider chips 横排 (多时区内滚动, 不撑爆弹层) */}
          {providerList.length > 0 && (
            <div className="flex flex-wrap gap-1 border-b border-[var(--border-soft)] px-2 py-2">
              {providerList.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    const first = groups.find(([pp]) => pp === p)?.[1]?.[0];
                    if (first) onPick(p, first.id);
                  }}
                  className={`rounded-full border px-2 py-[2px] text-mini transition duration-fast ease-out ${
                    p === provider
                      ? "border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "border-[var(--border-soft)] text-[var(--muted)] hover:border-[var(--border)] hover:text-[var(--fg)]"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
          {/* 当前 provider 的模型列表 */}
          <div className="max-h-56 overflow-auto py-1">
            {(groups.find(([p]) => p === provider)?.[1] ?? []).map((m) => (
              <button
                key={m.id}
                onClick={() => { onPick(provider, m.id); setOpenSel(false); }}
                className={`block w-full truncate px-3 py-2 text-left text-label transition duration-fast ease-out hover:bg-[var(--surface-2)] ${
                  model?.id === m.id ? "text-[var(--accent)]" : "text-[var(--muted)]"
                }`}
              >
                {m.name}
              </button>
            ))}
            {(groups.find(([p]) => p === provider)?.[1] ?? []).length === 0 && (
              <div className="px-3 py-2 text-label text-[var(--faint)]">无可用模型</div>
            )}
          </div>
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
  onOpenPanel,
  bottomLayer,
}: {
  emptyProject: string;
  // 卡片实际高度变化时回调 (App 据此调整消息区底部留白, 避免高输入框遮挡消息)
  onHeightChange?: (h: number) => void;
  // /skills /packages 本地命令: 打开 App 级右侧面板
  onOpenPanel?: (kind: "skills" | "packages") => void;
  // 输入卡底层插槽: 项目选择卡片等被输入卡压住、顶部露出一点的下层元素
  bottomLayer?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<Ref[]>([]);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [preview, setPreview] = useState<{ ref: Ref; content: string | null; loading: boolean } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // --- @引用 / /命令 触发状态机 ---
  // popup: 当前打开的弹层 (mention=@ 引用, command=/ 命令) 与查询词
  // triggerPosRef: 触发符在 text 里的位置 (删改/光标离开时失效)
  // dismissedRef: Esc 防抖记录 (触发词快照, 同一触发词不重弹, 触发词变化自然失效)
  const [popup, setPopup] = useState<{ kind: "mention" | "command"; query: string } | null>(null);
  const triggerPosRef = useRef(-1);
  const dismissedRef = useRef<string | null>(null);
  const mentionRef = useRef<MentionPopupHandle>(null);
  const paletteRef = useRef<CommandPaletteHandle>(null);
  const modelSelectOpen = useRef<(() => void) | null>(null);
  const thinkingSelectOpen = useRef<(() => void) | null>(null);
  // 触发词终结/光标离开时的被动关闭: 不清 Esc 防抖标志 (触发词变了自然失效)
  const closePopup = () => {
    setPopup(null);
    triggerPosRef.current = -1;
  };
  // Esc 关闭: 记录触发词防同一词立刻重弹; 用户继续输入改变触发词才允许重弹
  const dismissPopup = () => {
    if (!popup) return;
    const tr = triggerPosRef.current;
    dismissedRef.current = tr >= 0 ? text.slice(tr, tr + 1 + popup.query.length) : null;
    closePopup();
    textareaRef.current?.focus({ preventScroll: true });
  };

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
  const turnStats = active?.turnStats ?? null;
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
    textareaRef.current?.focus({ preventScroll: true });
  };

  // 输入变更: 驱动触发状态机 (词首 @ / / 检测 + 查询词维护 + 被动关闭)
  // 输入变更: 驱动触发状态机 (词首 @ / / 检测 + 查询词维护 + 被动关闭)
  // 组合期 (isComposing) 照常更新弹层: 拼音中间态过滤成空是正确响应, 上屏后自然纠正;
  // 无需守卫——组合期插入的是拼音/汉字不会误触发 @ /, 中文输入法空格选词不上屏,
  // Enter 选字已被 handleKey 的 isComposing 守卫拦截 (不会误发送)
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const t = e.target.value;
    const sel = e.target.selectionStart ?? t.length;
    setText(t);

    // 弹层打开态: 校验触发符仍在且光标未离开触发词; mention 遇空白即终结 (路径含空格选中即变 chip),
    // command 允许空白 (用户输参数) 但换行终结
    if (popup) {
      const tr = triggerPosRef.current;
      const ch = popup.kind === "mention" ? "@" : "/";
      if (tr < 0 || tr >= t.length || t[tr] !== ch || sel <= tr) { closePopup(); return; }
      for (let i = tr + 1; i < sel; i++) {
        if (popup.kind === "mention" ? /\s/.test(t[i]) : t[i] === "\n") { closePopup(); return; }
      }
      setPopup({ kind: popup.kind, query: t.slice(tr + 1, sel) });
      return;
    }

    // 弹层关闭态: 光标前字符是 @ 或 / 且其前为行首/空白 → 触发; 邮箱 (abc@def) 前有字母不触发
    if (sel >= 1 && (t[sel - 1] === "@" || t[sel - 1] === "/")) {
      const prevOk = sel < 2 || /\s/.test(t[sel - 2]);
      if (prevOk) {
        const isCmd = t[sel - 1] === "/";
        // 触发词 = 触发符到词尾: mention 到下一空白, command 到行尾 (参数可含空格)
        let end = sel;
        while (end < t.length && (isCmd ? t[end] !== "\n" : !/\s/.test(t[end]))) end++;
        const triggerWord = t.slice(sel - 1, end);
        // Esc 防抖: 触发词不变时 delete 类输入 (删字回到触发位) 不重弹;
        // insert 类输入 (用户主动重新打字/粘贴) 无条件允许重弹, 避免误拦重新输入 @ 的场景
        // (React 19 的 ChangeEvent.nativeEvent 类型是 Event, 运行时实为 InputEvent, 断言取 inputType)
        const inputType = (e.nativeEvent as InputEvent).inputType;
        if (dismissedRef.current !== triggerWord || inputType?.startsWith("insert")) {
          triggerPosRef.current = sel - 1;
          setPopup({ kind: isCmd ? "command" : "mention", query: t.slice(sel, end) });
        }
      }
    }
  };

  // 光标移动后检查是否离开触发词 (键盘移动与鼠标点击共用)
  const handleCursorMove = () => {
    if (!popup) return;
    const el = textareaRef.current;
    const tr = triggerPosRef.current;
    if (!el || tr < 0) return;
    const sel = el.selectionStart;
    const ch = popup.kind === "mention" ? "@" : "/";
    if (sel <= tr || tr >= el.value.length || el.value[tr] !== ch) {
      // 光标离开触发位: 重置防抖, 移回同一触发词允许重弹
      dismissedRef.current = null;
      closePopup();
    }
  };

  // 光标纯移动 (方向键/Home/End) 不触发 onChange: keyUp 后检查光标是否离开触发词
  const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    handleCursorMove();
  };

  // @ 选中: 删除触发文本 (触发符到词尾) + 追加 PathRef chip, 与「上下文」按钮同构
  const handlePickMention = (r: PathRef) => {
    const tr = triggerPosRef.current;
    if (tr < 0) { closePopup(); return; }
    let end = tr + 1;
    while (end < text.length && !/\s/.test(text[end])) end++;
    setText(text.slice(0, tr) + text.slice(end));
    // 光标定位回删除点, 便于继续输入
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) { el.focus({ preventScroll: true }); el.setSelectionRange(tr, tr); }
    });
    setRefs((prev) => [...prev, r]);
    dismissedRef.current = null; // 选中是主动操作: 下次 @ 正常重弹
    closePopup();
  };

  // / 命令执行: 本地动作调 store / 全局 UI; 透传原样 send_prompt("/name args")
  const handleExecuteCommand = async (cmd: PaletteCommand) => {
    const q = popup?.query ?? "";
    const first = q.split(/\s+/)[0] ?? "";
    // 参数只属于查询词首词对应的命令 (选中其它命令时丢弃, 用户没为它输参)
    const args = first === cmd.name ? q.slice(first.length).trim() : "";
    setPopup(null);
    triggerPosRef.current = -1;
    dismissedRef.current = null;

    if (cmd.source === "local") {
      const ok = await runLocalCommand(cmd.name);
      if (!ok) return; // 失败: hint 已显示, 保留输入框内容
    } else {
      // 透传: 原样发给 pi 解析执行 (扩展命令立即执行; 技能/模板按 pi 语义展开)
      if (!activeSessionId) {
        setHint("请先打开一个会话再执行命令");
        setTimeout(() => setHint(null), 2500);
        return;
      }
      await sendPrompt(activeSessionId, "/" + cmd.name + (args ? " " + args : ""));
    }
    setText("");
    textareaRef.current?.focus({ preventScroll: true });
  };

  // 本地白名单执行器: 返回 false = 执行失败 (hint 已提示, 输入框内容保留)
  const runLocalCommand = async (name: string): Promise<boolean> => {
    const showHint = (msg: string) => { setHint(msg); setTimeout(() => setHint(null), 2500); };
    switch (name) {
      case "new": {
        // 新建会话: 当前项目 (活跃会话 cwd 优先, 空状态用选择器值); 无项目给提示
        const cwd = active?.cwd || emptyProject;
        if (!cwd) { showHint("请先在上方选择项目"); return false; }
        try { await startSession(cwd); return true; }
        catch (e) { showHint(`新建会话失败: ${e}`); return false; }
      }
      case "model":
        if (!activeSessionId) { showHint("请先打开一个会话"); return false; }
        modelSelectOpen.current?.();
        return true;
      case "thinking":
        if (!activeSessionId) { showHint("请先打开一个会话"); return false; }
        thinkingSelectOpen.current?.();
        return true;
      case "stop":
        if (!activeSessionId || !isStreaming) { showHint("当前没有运行中的任务"); return false; }
        await abort(activeSessionId);
        return true;
      case "skills":
        onOpenPanel?.("skills");
        return true;
      case "packages":
        onOpenPanel?.("packages");
        return true;
      default:
        return false;
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    // 弹层打开: 键盘全部路由给弹层 (Enter 确认 / ↑↓ 导航 / Esc 关闭), 不进入发送逻辑
    if (popup) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        (popup.kind === "mention" ? mentionRef : paletteRef).current?.move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (popup.kind === "mention" ? mentionRef : paletteRef).current?.move(-1);
      } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (popup.kind === "mention") mentionRef.current?.confirm();
        else paletteRef.current?.confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        dismissPopup();
      }
      return;
    }
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

  // 统计条的耗时要按秒走字, 但 store 只存事实数据不存渲染节拍, 所以计时器放组件里。
  // 只在运行中跑, 停下就清掉 (空闲时定格显示上一轮结果, 没有重渲染的必要);
  // 计数值本身没人读, 自增只为触发重渲染让下面的 Date.now() 重新求值
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isStreaming) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isStreaming]);

  // 运行中读墙上时钟, 结束后读 store 里定格的值
  const elapsedMs = turnStats
    ? turnStats.elapsedMs ?? (turnStats.startedAt ? Date.now() - turnStats.startedAt : 0)
    : 0;
  const statTokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);
  const statDuration = (ms: number) => {
    const total = Math.floor(ms / 1000);
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
  };
  // 输出速度 = 本轮累计输出 ÷ 已耗时 (平均速度, 与其余四项同为累计口径;
  // elapsedMs 含 TTFT, 思考久时前期偏低属预期, 旁边就是耗时可自行判断)
  // 耗时 <1s 或尚无输出时显示 —, 避免除零噪声 (PRD B3)
  const outputTotal = turnStats ? turnStats.output + turnStats.liveOutput : 0;
  const speedTokPerSec =
    turnStats && elapsedMs >= 1000 && outputTotal > 0
      ? (outputTotal / (elapsedMs / 1000)).toFixed(1)
      : null;

  return (
    // 悬浮输入卡: 底部居中, 宽度与消息列表一致 (max-w-[min(75%,52rem)]), 与消息区分离成浮动层
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 mx-auto w-full max-w-[min(75%,52rem)]">
      {bottomLayer}
      <div
        ref={cardRef}
        // 半透明悬浮卡: 消息从卡片后方滑过时可见 (不挡内容), 轻模糊防文字混叠;
        // 圆角 16px (设计稿 .input-card) — 圆润不与系统直角冲突
        className="pointer-events-auto rounded-[16px] border border-[var(--border-soft)] bg-[color-mix(in_oklch,var(--surface-raised)_calc(var(--raised-alpha)_*_100%),transparent)] shadow-[0_-2px_20px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.10)] backdrop-blur-[2px] transition duration-fast ease-out focus-within:shadow-[0_0_24px_color-mix(in_oklch,var(--accent)_14%,transparent),0_-2px_20px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.10)]"
      >
        <div className="px-4 pt-3">
          {/* @引用 / /命令 浮层: 悬浮在输入卡上方 (与 RefsPopup 同模式), 不占卡片布局 */}
          <div className="relative">
            {popup?.kind === "mention" && (
              <MentionPopup
                root={active?.cwd || emptyProject}
                query={popup.query}
                onPick={handlePickMention}
                onClose={dismissPopup}
                ref={mentionRef}
              />
            )}
            {popup?.kind === "command" && (
              <CommandPalette
                sessionId={activeSessionId}
                streaming={isStreaming}
                query={popup.query}
                onExecute={handleExecuteCommand}
                onClose={dismissPopup}
                ref={paletteRef}
              />
            )}
          </div>
          {/* 引用 chips: 类型图标 + 标题 + 元信息, 点击预览, × 移除 */}
          {refs.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {refs.map((r, i) => {
                const Icon = refIcon(r);
                const meta = refMetaText(r);
                return (
                  <span
                    key={i}
                    className="flex items-center gap-2 rounded-md border border-[color-mix(in_oklch,var(--accent)_35%,transparent)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)] px-2 py-1 text-label text-[var(--accent-strong)]"
                  >
                    <Icon className="h-3 w-3" />
                    <button
                      onClick={() => openPreview(r)}
                      className="max-w-[180px] truncate hover:underline"
                      title="点击预览"
                    >
                      {r.title}
                    </button>
                    {meta && <span className="text-label text-[var(--faint)]">{meta}</span>}
                    <button
                      onClick={() => setRefs((prev) => prev.filter((_, j) => j !== i))}
                      className="rounded-sm p-1 transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--accent)_15%,transparent)]"
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
              <div className="absolute bottom-full left-0 z-50 mb-1 w-[420px] rounded-md border border-[var(--border-soft)] bg-[var(--panel)] shadow-lg">
                <div className="flex items-center justify-between border-b border-[var(--border-soft)] px-3 py-2">
                  <span className="flex items-center gap-2 text-label font-medium text-[var(--fg)]">
                    {(() => {
                      const Icon = refIcon(preview.ref);
                      return <Icon className="h-4 w-4 text-[var(--accent)]" />;
                    })()}
                    {preview.ref.title}
                  </span>
                  <button
                    onClick={() => setPreview(null)}
                    className="rounded-sm p-1 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-2)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="max-h-64 overflow-auto p-3">
                  {preview.loading ? (
                    <div className="flex items-center gap-2 text-label text-[var(--faint)]">
                      <Loader2 className="h-4 w-4 animate-spin" /> 加载预览…
                    </div>
                  ) : preview.ref.kind === "image" ||
                    preview.ref.kind === "screenshot" ||
                    preview.ref.kind === "clipboard-image" ? (
                    <img
                      src={`data:${preview.ref.mimeType};base64,${preview.ref.data}`}
                      alt={preview.ref.title}
                      className="max-h-56 rounded-md border border-[var(--border-soft)]"
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap text-label leading-relaxed text-[var(--muted)]">
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
          onChange={handleChange}
          onKeyDown={handleKey}
          onKeyUp={handleKeyUp}
          onMouseUp={handleCursorMove}
          placeholder={isStreaming ? "运行中: Enter 发 steer 指导, Alt+Enter 排队后续" : "输入消息, Enter 发送 (@ 引用文件/技能, / 命令)"}
          rows={2}
          className="max-h-[256px] w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-3 text-ui text-[var(--fg)] outline-none placeholder:text-[var(--faint)]"
        />

        {/* 输入框内底部工具行: 左上下文 / 右 context window + 选择器 + 发送 */}
        {hint && <p className="px-4 text-right text-label text-[var(--accent-strong)]">{hint}</p>}
        <div className="flex items-center justify-between px-2 pb-2">
          {/* 左下: 上下文添加 */}
          <div className="relative">
            <button
              onClick={() => setCtxOpen(!ctxOpen)}
              className="flex items-center gap-2 rounded-md px-2 py-2 text-label text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
              title="添加上下文"
            >
              <Paperclip className="h-4 w-4" />
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
              className="flex items-center gap-2 rounded-md px-2 py-2 text-label transition duration-fast ease-out hover:bg-[var(--surface-2)]"
              title={cuText ? `上下文 ${cuText} tokens` : "暂无上下文统计"}
            >
              <div className="h-2 w-16 overflow-hidden rounded-full bg-[var(--surface-2)]">
                <div
                  className={`h-full rounded-full transition-[width,background-color] duration-base ease-out ${
                    percent === null ? "bg-[var(--faint)]" : percent > 85 ? "bg-[var(--danger)]" : "bg-[var(--accent)]"
                  }`}
                  style={{ width: percent === null ? "0%" : `${Math.min(100, percent)}%` }}
                />
              </div>
              <span className="text-label tabular-nums text-[var(--faint)]">
                {percent === null ? "--" : `${Math.round(percent)}%`}
              </span>
            </div>

            {/* 模型选择 (provider + model 合并): 切 provider 自动选中该组第一个模型 */}
            <ModelPicker
              provider={selProvider}
              model={currentModel}
              models={availableModels}
              onPick={(p, mId) => {
                if (activeSessionId) setModel(activeSessionId, p, mId);
              }}
              disabled={!activeSessionId || availableModels.length === 0}
              openRef={modelSelectOpen}
            />
            <MiniSelect
              label="Thinking"
              icon={Brain}
              value={thinkingLevel}
              options={availableThinkingLevels}
              onChange={(lv) => activeSessionId && setThinkingLevel(activeSessionId, lv)}
              disabled={!activeSessionId || availableThinkingLevels.length <= 1}
              openRef={thinkingSelectOpen}
            />

            {isStreaming ? (
              <button
                onClick={() => activeSessionId && abort(activeSessionId)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--danger)_15%,transparent)] text-[var(--danger)] transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--danger)_25%,transparent)]"
                title="中止 (Enter 发 steer 指导)"
              >
                <Square className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={() => handleSend("prompt")}
                disabled={!text.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)] shadow-sm shadow-[color-mix(in_oklch,var(--accent)_30%,transparent)] transition duration-fast ease-out hover:bg-[var(--accent-strong)] active:scale-95 disabled:opacity-40"
                title="发送"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* 本轮运行统计: 顶替 pi-kitsune-ui 那条终端专用提示 (它带 ANSI + Nerd Font 码点, 已在
            store 的 notify 分支被过滤)。运行中实时跳动, settled 后定格, 下一轮 agent_start 重置 */}
        {turnStats && (
          <div
            className={`flex items-center gap-4 border-t border-[var(--border-soft)] px-4 py-2 text-label tabular-nums transition-colors duration-fast ease-out ${
              isStreaming ? "text-[var(--muted)]" : "text-[var(--faint)]"
            }`}
          >
            <span className="flex items-center gap-1" title="本轮输入 token">
              <ArrowUp className="h-3 w-3" />
              {statTokens(turnStats.input + turnStats.liveInput)}
            </span>
            <span className="flex items-center gap-1" title="本轮输出 token">
              <ArrowDown className="h-3 w-3" />
              {statTokens(turnStats.output + turnStats.liveOutput)}
            </span>
            <span className="flex items-center gap-1" title="本轮成本">
              <DollarSign className="h-3 w-3" />
              {turnStats.cost.toFixed(4)}
            </span>
            <span className="flex items-center gap-1" title="本轮输出速度">
              <Gauge className="h-3 w-3" />
              {speedTokPerSec === null ? "—" : `${speedTokPerSec} tok/s`}
            </span>
            <span className="flex items-center gap-1" title="本轮耗时">
              <Clock className="h-3 w-3" />
              {statDuration(elapsedMs)}
            </span>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
