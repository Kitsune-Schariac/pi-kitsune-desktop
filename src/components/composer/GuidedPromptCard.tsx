import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  HelpCircle,
  ShieldAlert,
  TextCursorInput,
  X,
} from "lucide-react";
import type {
  PromptQuestion,
  UserPromptRequest,
  UserPromptResponse,
} from "../../lib/agent";
import { Badge, Button, Input, Textarea } from "../ui";

/**
 * 跨 Agent 统一提问引导回复悬浮卡 (挂在输入卡正上方 `.composer-dock`):
 * - 承接 Claude Code `AskUserQuestion`、Pi `extension_ui_request` (`confirm`/`select`/`input`/`editor`)
 *   以及未来接入的其他 Agent 提问协议 (Codex `requestUserInput` / ACP 扩展等)
 * - 非全屏遮罩: 用户可边翻看上方对话/检查器代码边作答
 */
export function GuidedPromptCard({
  request,
  queueCount,
  escapeBlocked = false,
  onSubmit,
  onCancel,
}: {
  request: UserPromptRequest;
  /** 当前会话排队中的引导请求总数 (>1 时显示序号徽标) */
  queueCount: number;
  /** 输入卡内部有 @引用 / /命令 弹层打开时不抢 Esc 与数字快捷键 */
  escapeBlocked?: boolean;
  onSubmit: (response: UserPromptResponse) => void;
  onCancel: () => void;
}) {
  // 多题步进下标
  const [stepIdx, setStepIdx] = useState(0);
  // 每道题已选预设项: questionId → optionId[]
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  // 每道题是否启用「其他」自定义输入及文本
  const [customOn, setCustomOn] = useState<Record<string, boolean>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});
  // input / editor 文本值
  const [textVal, setTextVal] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  // 切换到新请求时重置全部局部状态
  useEffect(() => {
    setStepIdx(0);
    setSelected({});
    setCustomOn({});
    setCustomText({});
    setTextVal(request.prefill ?? "");
  }, [request.id, request.prefill]);

  // input / editor 出现时自动聚焦
  useEffect(() => {
    if (request.kind === "input") {
      inputRef.current?.focus({ preventScroll: true });
    } else if (request.kind === "editor") {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
  }, [request.id, request.kind]);

  const questions = request.questions;
  const currentQ: PromptQuestion | undefined = questions[stepIdx];

  // 计算某道题当前有效答案列表
  const answersForQuestion = (q: PromptQuestion): string[] => {
    const picked = selected[q.id] ?? [];
    const custom = customOn[q.id] ? (customText[q.id] ?? "").trim() : "";
    if (q.multiSelect) {
      return custom ? [...picked, custom] : picked;
    }
    if (customOn[q.id]) return custom ? [custom] : [];
    return picked.slice(0, 1);
  };

  const answeredCount = useMemo(
    () => questions.filter((q) => answersForQuestion(q).length > 0).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [questions, selected, customOn, customText],
  );

  const canSubmitQuestions =
    questions.length > 0 && answeredCount === questions.length;

  const submitQuestions = (override?: { qid: string; vals: string[] }) => {
    const answers: Record<string, string[]> = {};
    for (const q of questions) {
      const vals = override && override.qid === q.id ? override.vals : answersForQuestion(q);
      if (vals.length > 0) answers[q.id] = vals;
    }
    onSubmit({ action: "submit", answers });
  };

  const handleSelectOption = (q: PromptQuestion, optionId: string) => {
    if (q.multiSelect) {
      setSelected((prev) => {
        const list = prev[q.id] ?? [];
        const next = list.includes(optionId)
          ? list.filter((x) => x !== optionId)
          : [...list, optionId];
        return { ...prev, [q.id]: next };
      });
      return;
    }

    // 单选: 关闭本项「其他」自定义态
    setCustomOn((prev) => (prev[q.id] ? { ...prev, [q.id]: false } : prev));
    setSelected((prev) => ({ ...prev, [q.id]: [optionId] }));

    // 单题且无自定义选项 (如 Pi select): 点选即提交, 零额外点击
    if (questions.length === 1 && !q.allowCustom) {
      submitQuestions({ qid: q.id, vals: [optionId] });
      return;
    }

    // 多题模式: 自动前进到下一道尚未作答的题
    if (questions.length > 1 && stepIdx < questions.length - 1) {
      setStepIdx(stepIdx + 1);
    }
  };

  const handleToggleCustom = (q: PromptQuestion) => {
    const nextOn = !customOn[q.id];
    setCustomOn((prev) => ({ ...prev, [q.id]: nextOn }));
    if (nextOn && !q.multiSelect) {
      // 单选模式下选「其他」清掉预设选中
      setSelected((prev) => ({ ...prev, [q.id]: [] }));
    }
    if (nextOn) {
      requestAnimationFrame(() => customInputRef.current?.focus({ preventScroll: true }));
    }
  };

  // Esc 取消与数字键 1-9 快捷选单 (不抢输入框和上层弹窗的焦点)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (escapeBlocked) return;
      if (document.querySelector("[data-overlay]")) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;

      if (e.key === "Escape" && request.allowCancel) {
        if (typing && target !== inputRef.current && target !== textareaRef.current && target !== customInputRef.current) {
          return;
        }
        e.preventDefault();
        onCancel();
        return;
      }

      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (request.kind === "questions" && currentQ && e.key >= "1" && e.key <= "9") {
        const idx = Number(e.key) - 1;
        const opt = currentQ.options[idx];
        if (opt) {
          e.preventDefault();
          handleSelectOption(currentQ, opt.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escapeBlocked, request.id, request.kind, request.allowCancel, currentQ, stepIdx, questions.length]);

  const HeaderIcon =
    request.kind === "confirm"
      ? ShieldAlert
      : request.kind === "editor"
        ? FileText
        : request.kind === "input"
          ? TextCursorInput
          : HelpCircle;

  const titleText =
    request.title ||
    (request.kind === "confirm"
      ? "请确认操作"
      : request.kind === "input"
        ? "请输入内容"
        : request.kind === "editor"
          ? "编辑内容"
          : "需要你的回复");

  return (
    <section
      className="pointer-events-auto overflow-hidden rounded-lg border border-line-2 bg-popover shadow-lg view-in-soft"
      role="region"
      aria-label={titleText}
    >
      {/* 卡片头: 图标 + 标题 + 排队数 + 取消 */}
      <div className="flex h-10 items-center gap-2 border-b border-line px-4">
        <HeaderIcon className="h-[14px] w-[14px] shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
          {titleText}
        </span>
        {queueCount > 1 && (
          <Badge tone="neutral" className="shrink-0 tabular-nums">
            1 / {queueCount}
          </Badge>
        )}
        {request.allowCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-4 transition-colors duration-fast ease-out hover:bg-hover hover:text-fg"
            title="取消 (Esc)"
            aria-label="取消"
          >
            <X className="h-[14px] w-[14px]" />
          </button>
        )}
      </div>

      {/* 主体区: 限制最大高度, 长列表内部滚动不把对话区压扁 */}
      <div className="max-h-[42vh] overflow-y-auto px-4 py-3">
        {request.kind === "questions" && currentQ && (
          <div className="space-y-3">
            {/* 多题顶部步骤胶囊 */}
            {questions.length > 1 && (
              <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="问题列表">
                {questions.map((q, i) => {
                  const done = answersForQuestion(q).length > 0;
                  const active = i === stepIdx;
                  return (
                    <button
                      key={q.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setStepIdx(i)}
                      className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-meta transition-colors duration-fast ease-out ${
                        active
                          ? "bg-accent font-medium text-on-accent"
                          : done
                            ? "bg-well text-fg"
                            : "text-fg-3 hover:bg-hover hover:text-fg"
                      }`}
                    >
                      {done && (
                        <Check
                          className={`h-3 w-3 shrink-0 ${active ? "text-on-accent" : "text-ok"}`}
                        />
                      )}
                      <span>{q.header || `问题 ${i + 1}`}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* 当前问题正文 */}
            <div className="flex items-start gap-2">
              {questions.length === 1 && currentQ.header && (
                <Badge tone="neutral" className="mt-[2px] shrink-0">
                  {currentQ.header}
                </Badge>
              )}
              <p className="min-w-0 flex-1 text-body font-medium leading-relaxed text-fg">
                {currentQ.prompt}
              </p>
              {currentQ.multiSelect && (
                <Badge tone="neutral" className="shrink-0">
                  可多选
                </Badge>
              )}
            </div>

            {/* 选项卡片列表 */}
            <div className="space-y-2">
              {currentQ.options.map((opt, idx) => {
                const picked = (selected[currentQ.id] ?? []).includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSelectOption(currentQ, opt.id)}
                    aria-pressed={picked}
                    className={`flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-fast ease-out ${
                      picked
                        ? "border-accent bg-accent-soft text-fg"
                        : "border-edge bg-card text-fg-2 hover:border-line-2 hover:bg-hover hover:text-fg"
                    }`}
                  >
                    <span
                      className={`mt-[2px] grid h-4 w-4 shrink-0 place-items-center border transition-colors duration-fast ease-out ${
                        currentQ.multiSelect ? "rounded-[4px]" : "rounded-full"
                      } ${
                        picked
                          ? "border-accent bg-accent text-on-accent"
                          : "border-line-2 bg-transparent"
                      }`}
                      aria-hidden
                    >
                      {picked &&
                        (currentQ.multiSelect ? (
                          <Check className="h-3 w-3" strokeWidth={2.5} />
                        ) : (
                          <span className="h-[6px] w-[6px] rounded-full bg-on-accent" />
                        ))}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-body font-medium text-fg">{opt.label}</span>
                        {opt.recommended && (
                          <Badge tone="ok" className="shrink-0">
                            推荐
                          </Badge>
                        )}
                      </div>
                      {opt.description && (
                        <p className="mt-1 text-label leading-snug text-fg-3">
                          {opt.description}
                        </p>
                      )}
                    </div>

                    {idx < 9 && (
                      <kbd className="mt-[2px] hidden h-5 min-w-5 shrink-0 place-items-center rounded-[6px] bg-fg/[0.06] px-1 font-mono text-meta text-fg-4 sm:grid">
                        {idx + 1}
                      </kbd>
                    )}
                  </button>
                );
              })}

              {/* 自定义「其他」选项 */}
              {currentQ.allowCustom && (
                <div
                  className={`rounded-md border px-3 py-2 transition-colors duration-fast ease-out ${
                    customOn[currentQ.id]
                      ? "border-accent bg-accent-soft"
                      : "border-edge bg-card hover:border-line-2"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleToggleCustom(currentQ)}
                    className="flex w-full items-center gap-3 text-left"
                    aria-pressed={!!customOn[currentQ.id]}
                  >
                    <span
                      className={`grid h-4 w-4 shrink-0 place-items-center border transition-colors duration-fast ease-out ${
                        currentQ.multiSelect ? "rounded-[4px]" : "rounded-full"
                      } ${
                        customOn[currentQ.id]
                          ? "border-accent bg-accent text-on-accent"
                          : "border-line-2 bg-transparent"
                      }`}
                      aria-hidden
                    >
                      {customOn[currentQ.id] &&
                        (currentQ.multiSelect ? (
                          <Check className="h-3 w-3" strokeWidth={2.5} />
                        ) : (
                          <span className="h-[6px] w-[6px] rounded-full bg-on-accent" />
                        ))}
                    </span>
                    <span className="text-body text-fg-2">其他（自定义回复）</span>
                  </button>
                  {customOn[currentQ.id] && (
                    <div className="mt-2 pl-7">
                      <Input
                        ref={customInputRef}
                        density="sm"
                        value={customText[currentQ.id] ?? ""}
                        onChange={(e) =>
                          setCustomText((prev) => ({ ...prev, [currentQ.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            if (stepIdx < questions.length - 1) setStepIdx(stepIdx + 1);
                            else if (canSubmitQuestions) submitQuestions();
                          }
                        }}
                        placeholder="输入你的补充意见或自定义答案…"
                      />
                    </div>
                  )}
                </div>
              )}

              {currentQ.options.length === 0 && !currentQ.allowCustom && (
                <p className="text-body text-fg-4">没有可用选项</p>
              )}
            </div>
          </div>
        )}

        {request.kind === "confirm" && (
          <p className="text-body leading-relaxed text-fg-2">
            {request.description || "请确认是否继续执行此操作"}
          </p>
        )}

        {request.kind === "input" && (
          <div className="space-y-2">
            {request.description && (
              <p className="text-label leading-relaxed text-fg-3">{request.description}</p>
            )}
            <Input
              ref={inputRef}
              value={textVal}
              onChange={(e) => setTextVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onSubmit({ action: "submit", text: textVal });
                }
              }}
              placeholder={request.placeholder || "输入内容…"}
            />
          </div>
        )}

        {request.kind === "editor" && (
          <div className="space-y-2">
            {request.description && (
              <p className="text-label leading-relaxed text-fg-3">{request.description}</p>
            )}
            <Textarea
              ref={textareaRef}
              value={textVal}
              onChange={(e) => setTextVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  onSubmit({ action: "submit", text: textVal });
                }
              }}
              rows={5}
              placeholder={request.placeholder || "输入多行内容（Ctrl+Enter 提交）…"}
              className="font-mono"
            />
          </div>
        )}
      </div>

      {/* 底部动作栏 */}
      {(request.kind !== "questions" || questions.length > 1 || currentQ?.multiSelect || currentQ?.allowCustom) && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2">
          <div className="flex items-center gap-1">
            {request.kind === "questions" && questions.length > 1 && (
              <>
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={stepIdx === 0}
                  onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
                >
                  <ChevronLeft className="h-3 w-3" />
                  上一题
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={stepIdx >= questions.length - 1}
                  onClick={() => setStepIdx((i) => Math.min(questions.length - 1, i + 1))}
                >
                  下一题
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <span className="ml-1 text-meta tabular-nums text-fg-4">
                  已答 {answeredCount}/{questions.length}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {request.allowCancel && (
              <Button size="sm" onClick={onCancel}>
                取消
              </Button>
            )}
            {request.kind === "questions" ? (
              <Button
                size="sm"
                variant="primary"
                disabled={!canSubmitQuestions}
                onClick={() => submitQuestions()}
              >
                提交回答
              </Button>
            ) : request.kind === "confirm" ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => onSubmit({ action: "submit", confirmed: true })}
              >
                确认
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                onClick={() => onSubmit({ action: "submit", text: textVal })}
              >
                提交
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
