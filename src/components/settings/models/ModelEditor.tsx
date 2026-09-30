// 第三栏: 选中模型的编辑器。表单模式按「左标签 + 右控件」分组; JSON 模式编辑整个模型对象。
// 表单与 JSON 不同屏, 不存在两个编辑器改同一份数据的同步问题 (取代旧面板的 compatRev / levelRev)。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Boxes,
  Braces,
  Brain,
  Check,
  CircleAlert,
  Copy,
  CopyPlus,
  Download,
  Image,
  Plus,
  Star,
  Trash2,
  Type,
  type LucideIcon,
} from "lucide-react";
import {
  COMPAT_FLAGS,
  COST_MAIN_KEYS,
  isObj,
  modelOf,
  setLeaveGuard,
  useModelsConfigStore,
  type JsonObject,
} from "../../../store/modelsConfig";
import { formatTokenExact, parseTokenCount } from "../../../lib/tokenCount";
import { Button, Input, Segmented } from "../../ui";
import { CopyToDialog, FetchModelsDialog } from "./dialogs";
import { Badge, FieldError, IconButton, LINK, useElementWidth } from "./shared";
import { ThinkingLevelMap } from "./ThinkingLevelMap";

export type EditorMode = "form" | "json";

const KNOWN_KEYS = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "thinkingLevelMap", "compat"];
const COST_LABELS: Record<(typeof COST_MAIN_KEYS)[number], string> = {
  input: "输入",
  output: "输出",
  cacheRead: "缓存读",
  cacheWrite: "缓存写",
};
const COMPAT_DESC: Record<(typeof COMPAT_FLAGS)[number], string> = {
  supportsDeveloperRole: "system 提示改用 developer 角色发送",
  supportsReasoningEffort: "请求里带上 reasoning_effort 参数",
};
const CTX_PRESETS: [number, string][] = [
  [128000, "128k"],
  [200000, "200k"],
  [256000, "256k"],
  [1000000, "1M"],
];
const MAX_PRESETS: [number, string][] = [
  [16384, "16K"],
  [32768, "32K"],
  [65536, "64K"],
  [131072, "128K"],
];
const JSON_SLOT = "model-json";

const CHIP_ON = "border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[var(--accent-soft)] text-[var(--accent)]";
const CHIP_OFF = "border-[var(--line)] bg-[var(--well)] text-[var(--fg-3)] hover:border-[var(--line-2)] hover:text-[var(--fg)]";

export function ModelEditor({
  pid,
  mid,
  mode,
  onModeChange,
  onBack,
  onJsonError,
}: {
  pid: string;
  mid: string;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  /** 两栏布局下返回模型列表 */
  onBack?: () => void;
  onJsonError: (key: string, msg: string | null) => void;
}) {
  const doc = useModelsConfigStore((s) => s.doc);
  const defaults = useModelsConfigStore((s) => s.defaults);
  const settingsParseError = useModelsConfigStore((s) => s.settingsParseError);
  const setDefaults = useModelsConfigStore((s) => s.setDefaults);
  const deleteModel = useModelsConfigStore((s) => s.deleteModel);
  const duplicateModel = useModelsConfigStore((s) => s.duplicateModel);
  const setModelObject = useModelsConfigStore((s) => s.setModelObject);
  const notify = useModelsConfigStore((s) => s.notify);

  const model = modelOf(doc, pid, mid);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);
  const [copying, setCopying] = useState(false);

  // ---- JSON 模式 ----
  const serialized = model ? JSON.stringify(model, null, 2) : "";
  const [jsonText, setJsonText] = useState(serialized);
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const jsonTextRef = useRef(jsonText);
  const jsonFocused = useRef(false);
  const lastSerialized = useRef(serialized);

  // 模型被外部改了 (表单编辑 / 撤销 / 重新加载) 而 JSON 框没在编辑 → 重灌草稿。
  // 不这样做的话, 重新加载后旧草稿会在下一次失焦时被写回, 等于复活已放弃的改动
  useEffect(() => {
    if (serialized === lastSerialized.current) return;
    lastSerialized.current = serialized;
    if (!jsonFocused.current) {
      setJsonText(serialized);
      jsonTextRef.current = serialized;
      setJsonErr(null);
      onJsonError(JSON_SLOT, null);
    }
  }, [serialized, onJsonError]);

  const reportJson = useCallback(
    (msg: string | null) => {
      setJsonErr(msg);
      onJsonError(JSON_SLOT, msg);
    },
    [onJsonError],
  );

  // 校验并整体替换; 返回 false 时调用方必须留在原地 (不切表单 / 不切模型)
  const applyJson = useCallback((): boolean => {
    const text = jsonTextRef.current;
    const current = modelOf(useModelsConfigStore.getState().doc, pid, mid);
    if (!current || text === JSON.stringify(current, null, 2)) {
      reportJson(null);
      return true;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      reportJson(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const err = setModelObject(pid, mid, value);
    reportJson(err);
    return err === null;
  }, [pid, mid, setModelObject, reportJson]);

  useEffect(() => {
    if (mode !== "json") {
      // 模式被外部切回表单 (如「重新加载」) 时没经过 applyJson: 丢掉未应用的草稿并清错误槽位,
      // 否则槽位里残留的 JSON 错误会让保存按钮一直禁用到切换模型为止
      if (jsonTextRef.current !== lastSerialized.current) {
        setJsonText(lastSerialized.current);
        jsonTextRef.current = lastSerialized.current;
      }
      reportJson(null);
      return;
    }
    setLeaveGuard(applyJson);
    return () => setLeaveGuard(null);
  }, [mode, applyJson, reportJson]);
  useEffect(() => () => onJsonError(JSON_SLOT, null), [onJsonError]);

  if (!model) return null;

  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    if (next === "form" && !applyJson()) return;
    onModeChange(next);
  };

  const isDefault = defaults?.provider === pid && defaults.model === mid;
  const canSetDefault = !!defaults && !settingsParseError;
  const stacked = width > 0 && width < 560;
  const labelCol = stacked ? "grid-cols-1" : width >= 720 ? "grid-cols-[148px_minmax(0,1fr)]" : "grid-cols-[120px_minmax(0,1fr)]";
  const name = typeof model.name === "string" ? model.name : "";

  return (
    <section ref={rootRef} className="min-h-0 min-w-0 overflow-y-auto">
      <div className={`max-w-[880px] pb-10 pt-5 ${stacked ? "px-4" : "px-7"}`}>
        <div className="flex flex-wrap items-start gap-4 border-b border-[var(--line)] pb-4">
          {onBack && (
            <button
              onClick={() => {
                if (mode !== "json" || applyJson()) onBack();
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-label text-[var(--fg-3)] transition-colors duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
            >
              <ArrowLeft className="h-[14px] w-[14px]" />
              模型列表
            </button>
          )}
          <div className="min-w-[200px] flex-1">
            <div className="break-all font-mono text-head font-semibold text-[var(--fg)]">{mid}</div>
            <div className="mt-[2px] text-label text-[var(--fg-3)]">
              {name || "未命名"} · {pid}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isDefault ? (
              <Badge tone="accent">
                <Star className="h-3 w-3" />
                新会话默认
              </Badge>
            ) : (
              <Button
                size="sm"
                disabled={!canSetDefault}
                title={canSetDefault ? "保存后写入 settings.json" : "settings.json 不可用"}
                onClick={() => {
                  setDefaults({ provider: pid, model: mid });
                  notify(`新会话默认改为 ${mid}, 保存后写入 settings.json`);
                }}
              >
                <Star className="h-[14px] w-[14px]" />
                设为默认
              </Button>
            )}
            <Button size="sm" onClick={() => setCopying(true)}>
              <Copy className="h-[14px] w-[14px]" />
              复制到…
            </Button>
            <IconButton title="在这个供应商里复制一份" onClick={() => duplicateModel(pid, mid)}>
              <CopyPlus className="h-[14px] w-[14px]" />
            </IconButton>
            <IconButton title="删除模型 (保存前可撤销)" danger onClick={() => deleteModel(pid, mid)}>
              <Trash2 className="h-[14px] w-[14px]" />
            </IconButton>
            <Segmented
              size="sm"
              value={mode}
              onChange={switchMode}
              options={[
                { value: "form", label: "表单" },
                { value: "json", label: "JSON" },
              ]}
            />
          </div>
        </div>

        {mode === "json" ? (
          <div className="flex flex-col gap-2 pt-4">
            <textarea
              value={jsonText}
              spellCheck={false}
              onFocus={() => {
                jsonFocused.current = true;
              }}
              onChange={(e) => {
                setJsonText(e.target.value);
                jsonTextRef.current = e.target.value;
                // 已经改到能解析了就撤掉红框, 不必等失焦 (结构错误仍在应用时报)
                if (jsonErr) {
                  try {
                    JSON.parse(e.target.value);
                    reportJson(null);
                  } catch {
                    /* 仍非法 */
                  }
                }
              }}
              onBlur={() => {
                jsonFocused.current = false;
                applyJson();
              }}
              className={`min-h-[460px] w-full resize-y rounded-md border bg-[var(--well)] px-3 py-2 font-mono text-label leading-relaxed text-[var(--fg)] outline-none transition-colors duration-fast ease-out ${
                jsonErr ? "border-[var(--err)]" : "border-[var(--line)] focus:border-[var(--accent)]"
              }`}
            />
            <div className="flex flex-wrap items-center justify-between gap-3 text-mini">
              {jsonErr ? (
                <span className="inline-flex items-center gap-2 text-[var(--err)]">
                  <CircleAlert className="h-3 w-3 shrink-0" />
                  {jsonErr}
                </span>
              ) : (
                <span className="text-[var(--fg-4)]">整个模型对象。未知字段原样保留, 失焦、点「应用」或切回表单时生效。</span>
              )}
              <Button
                size="sm"
                onClick={() => {
                  if (applyJson()) notify("已应用");
                }}
              >
                应用
              </Button>
            </div>
          </div>
        ) : (
          <ModelForm pid={pid} mid={mid} model={model} labelCol={labelCol} stacked={stacked} onJson={() => switchMode("json")} />
        )}
      </div>
      {copying && <CopyToDialog pid={pid} mid={mid} onClose={() => setCopying(false)} />}
    </section>
  );
}

/** 没有选中模型时的第三栏 */
export function EditorPlaceholder({ pid, hasModels, onAdd }: { pid: string; hasModels: boolean; onAdd: () => void }) {
  const [fetching, setFetching] = useState(false);
  return (
    <section className="grid min-h-0 min-w-0 place-content-center justify-items-center gap-3 p-10 text-center text-label text-[var(--fg-3)]">
      <Boxes className="h-8 w-8 text-[var(--fg-4)]" />
      <span>{hasModels ? "选一个模型开始编辑" : "这个供应商还没有模型"}</span>
      {!hasModels && (
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" onClick={() => setFetching(true)}>
            <Download className="h-[14px] w-[14px]" />
            拉取模型列表
          </Button>
          <Button size="sm" onClick={onAdd}>
            <Plus className="h-[14px] w-[14px]" />
            手动新增
          </Button>
        </div>
      )}
      {fetching && <FetchModelsDialog pid={pid} onClose={() => setFetching(false)} />}
    </section>
  );
}


function Row({ title, hint, labelCol, children }: { title: string; hint: string; labelCol: string; children: ReactNode }) {
  return (
    <div className={`grid gap-x-6 gap-y-2 border-b border-[var(--line)] py-4 last:border-b-0 ${labelCol}`}>
      <div>
        <div className="text-body font-semibold text-[var(--fg)]">{title}</div>
        <div className="mt-[2px] text-mini leading-snug text-[var(--fg-4)]">{hint}</div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </div>
  );
}


function ModelForm({
  pid,
  mid,
  model,
  labelCol,
  stacked,
  onJson,
}: {
  pid: string;
  mid: string;
  model: JsonObject;
  labelCol: string;
  stacked: boolean;
  onJson: () => void;
}) {
  const renameModel = useModelsConfigStore((s) => s.renameModel);
  const setModelField = useModelsConfigStore((s) => s.setModelField);
  const setModelCompatFlag = useModelsConfigStore((s) => s.setModelCompatFlag);
  const [midDraft, setMidDraft] = useState(mid);
  const [midErr, setMidErr] = useState<string | null>(null);

  const commitMid = () => {
    const next = midDraft.trim();
    if (next === mid) return;
    if (!next) {
      setMidErr("ID 不能为空");
      setMidDraft(mid);
    } else if (!renameModel(pid, mid, next)) {
      setMidErr(`「${next}」已经存在`);
      setMidDraft(mid);
    }
  };

  const inputs: unknown[] = Array.isArray(model.input) ? model.input : [];
  const unknownInputs = inputs.filter((x) => x !== "text" && x !== "image");
  // 已知取值按固定顺序排前, 不认识的取值原样接在后面 (保真: 未来的模态类型不能被一次点击抹掉)
  const toggleInput = (kind: "text" | "image") => {
    const set = new Set(inputs.filter((x): x is string => x === "text" || x === "image"));
    if (set.has(kind)) set.delete(kind);
    else set.add(kind);
    const next = [...(["text", "image"] as const).filter((k) => set.has(k)), ...unknownInputs];
    setModelField(pid, mid, "input", next.length ? next : null);
  };

  const compatRaw = model.compat;
  const compat = isObj(compatRaw) ? compatRaw : {};
  const otherCompat = Object.keys(compat).filter((k) => !(COMPAT_FLAGS as readonly string[]).includes(k));
  const otherKeys = Object.keys(model).filter((k) => !KNOWN_KEYS.includes(k));

  return (
    <div>
      <Row title="标识" hint="id 原样发给供应商; 显示名只在界面里用" labelCol={labelCol}>
        <div className={`grid gap-3 ${stacked ? "grid-cols-1" : "grid-cols-2"}`}>
          <label className="flex flex-col gap-1">
            <span className="text-mini text-[var(--fg-4)]">ID</span>
            <Input
              className="font-mono"
              value={midDraft}
              onChange={(e) => {
                setMidDraft(e.target.value);
                setMidErr(null);
              }}
              onBlur={commitMid}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
              }}
            />
            {midErr && <FieldError>{midErr}</FieldError>}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-mini text-[var(--fg-4)]">显示名</span>
            <Input
              value={typeof model.name === "string" ? model.name : ""}
              placeholder={mid}
              onChange={(e) => setModelField(pid, mid, "name", e.target.value)}
            />
          </label>
        </div>
      </Row>

      <Row title="能力" hint="决定能不能开思考、能不能发图" labelCol={labelCol}>
        <div className="flex flex-wrap gap-2">
          <CapToggle
            on={model.reasoning === true}
            icon={Brain}
            label="推理"
            onClick={() => setModelField(pid, mid, "reasoning", model.reasoning !== true)}
          />
          <CapToggle on={inputs.includes("text")} icon={Type} label="文本输入" onClick={() => toggleInput("text")} />
          <CapToggle on={inputs.includes("image")} icon={Image} label="图像输入" onClick={() => toggleInput("image")} />
          {unknownInputs.map((x, i) => (
            <Badge key={i} title="本版本不认识的输入类型, 原样保留">
              {typeof x === "string" ? x : JSON.stringify(x)}
            </Badge>
          ))}
        </div>
      </Row>

      <Row title="上下文窗口" hint="可以写 976k、1M、20万 这样的简写" labelCol={labelCol}>
        <TokenField pid={pid} mid={mid} field="contextWindow" value={model.contextWindow} presets={CTX_PRESETS} />
      </Row>
      <Row title="最大输出" hint="单次回复的 token 上限" labelCol={labelCol}>
        <TokenField pid={pid} mid={mid} field="maxTokens" value={model.maxTokens} presets={MAX_PRESETS} />
      </Row>

      <Row title="价格" hint="$ / 百万 token, 用于成本统计" labelCol={labelCol}>
        <CostGrid pid={pid} mid={mid} cost={model.cost} stacked={stacked} />
      </Row>

      <Row title="思考档位映射" hint="pi 的 7 个思考档位分别发给供应商什么值" labelCol={labelCol}>
        <ThinkingLevelMap pid={pid} mid={mid} model={model} />
      </Row>

      <Row title="兼容" hint="选「自动」时由 pi 按地址自己判断" labelCol={labelCol}>
        {compatRaw !== undefined && !isObj(compatRaw) ? (
          <span className="flex items-start gap-2 text-mini text-[var(--err)]">
            <CircleAlert className="mt-[2px] h-3 w-3 shrink-0" />
            compat 不是对象,
            <button className={LINK} onClick={onJson}>
              在 JSON 中修正
            </button>
          </span>
        ) : (
          <>
            {COMPAT_FLAGS.map((k) => {
              const v = compat[k];
              const cur = v === undefined ? "auto" : v === true ? "on" : v === false ? "off" : null;
              return (
                <div key={k} className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="font-mono text-label text-[var(--fg)]">{k}</span>
                    <span className="text-mini text-[var(--fg-3)]">
                      {COMPAT_DESC[k]}
                      {cur === null && <span className="text-[var(--err)]"> · 值异常 ({JSON.stringify(v)})</span>}
                    </span>
                  </div>
                  <Segmented
                    size="sm"
                    value={cur}
                    onChange={(s) => setModelCompatFlag(pid, mid, k, s === "auto" ? undefined : s === "on")}
                    options={[
                      { value: "auto", label: "自动" },
                      { value: "on", label: "开" },
                      { value: "off", label: "关" },
                    ]}
                  />
                </div>
              );
            })}
            {otherCompat.length > 0 && (
              <span className="flex flex-wrap items-start gap-1 text-mini leading-relaxed text-[var(--fg-4)]">
                <Braces className="mt-[2px] h-3 w-3 shrink-0" />
                另有 {otherCompat.length} 个兼容键:
                <span className="font-mono">{otherCompat.join("、")}</span>
                <button className={LINK} onClick={onJson}>
                  在 JSON 中编辑
                </button>
              </span>
            )}
          </>
        )}
      </Row>

      <Row title="其他字段" hint="少用的字段, 在 JSON 里编辑" labelCol={labelCol}>
        {otherKeys.length ? (
          <>
            <div className="flex flex-wrap gap-1">
              {otherKeys.map((k) => (
                <Badge key={k} className="font-mono">
                  {k}
                </Badge>
              ))}
            </div>
            <div>
              <button className={LINK} onClick={onJson}>
                在 JSON 中编辑
              </button>
            </div>
          </>
        ) : (
          <span className="text-mini text-[var(--fg-4)]">
            没有其他字段。samplingParams、headers 这类可以
            <button className={LINK} onClick={onJson}>
              在 JSON 里添加
            </button>
          </span>
        )}
      </Row>
    </div>
  );
}

function CapToggle({ on, icon: Icon, label, onClick }: { on: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex h-[30px] items-center gap-2 rounded-md border px-3 text-label transition-colors duration-fast ease-out ${
        on
          ? "border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[var(--accent-soft)] text-[var(--accent)]"
          : "border-[var(--line-2)] text-[var(--fg-3)] hover:border-[var(--fg-4)] hover:text-[var(--fg)]"
      }`}
    >
      <Check className={`h-3 w-3 ${on ? "opacity-100" : "opacity-0"}`} />
      <Icon className="h-[14px] w-[14px]" />
      {label}
    </button>
  );
}

/** 上下文窗口 / 最大输出: 草稿 + 失焦提交, 接受 200k / 1.2M / 20万, 非法标红不落盘 */
function TokenField({
  pid,
  mid,
  field,
  value,
  presets,
}: {
  pid: string;
  mid: string;
  field: string;
  value: unknown;
  presets: [number, string][];
}) {
  const setModelNumber = useModelsConfigStore((s) => s.setModelNumber);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? formatTokenExact(value);
  const n = parseTokenCount(text);
  const bad = Number.isNaN(n);
  // 手写的怪值 (字符串数字 / 负数) 在输入框里显示为空, 必须另外点出来, 否则看着像「未设置」
  const odd = draft === null && value !== undefined && !(typeof value === "number" && value > 0);

  const commit = () => {
    if (draft === null || bad) return;
    setModelNumber(pid, mid, field, n);
    setDraft(null);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className={`w-[140px] font-mono tabular-nums ${bad ? "!border-[var(--err)]" : ""}`}
          value={text}
          placeholder="未设置"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
          }}
        />
        <span className="text-mini text-[var(--fg-4)]">
          {bad ? (
            <FieldError>写成 200000、200k 或 1M</FieldError>
          ) : n !== null ? (
            <span className="font-mono tabular-nums">= {n.toLocaleString("en-US")} tokens</span>
          ) : odd ? (
            <FieldError>当前值异常: {JSON.stringify(value)}</FieldError>
          ) : (
            "未设置"
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {presets.map(([v, label]) => (
          <button
            key={v}
            onClick={() => {
              setModelNumber(pid, mid, field, v);
              setDraft(null);
            }}
            className={`h-6 rounded-[6px] border px-2 font-mono text-mini transition-colors duration-fast ease-out ${
              value === v ? CHIP_ON : CHIP_OFF
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

/** 价格四格: 任一格有值即四键补全, 清空一格落 0; 非法输入标红不落盘 */
function CostGrid({ pid, mid, cost: costRaw, stacked }: { pid: string; mid: string; cost: unknown; stacked: boolean }) {
  const setModelCostText = useModelsConfigStore((s) => s.setModelCostText);
  const setModelField = useModelsConfigStore((s) => s.setModelField);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<Record<string, boolean>>({});
  const cost = isObj(costRaw) ? costRaw : null;

  const textOf = (k: string) => drafts[k] ?? (cost && k in cost ? String(cost[k]) : "");
  const clearDraft = (k: string) =>
    setDrafts((p) => {
      const n = { ...p };
      delete n[k];
      return n;
    });
  const commit = (k: string) => {
    const t = drafts[k];
    if (t === undefined) return;
    if (!cost && !t.trim()) {
      // 原本没有价格, 点进来又空着出去: 不造一个全零 cost
      clearDraft(k);
      return;
    }
    if (setModelCostText(pid, mid, k, t)) {
      clearDraft(k);
      setBad((p) => ({ ...p, [k]: false }));
    } else {
      setBad((p) => ({ ...p, [k]: true }));
    }
  };
  const num = (k: string) => (cost && typeof cost[k] === "number" ? (cost[k] as number) : 0);
  // 典型一轮: 50k 输入里 40k 命中缓存、2k 输出 —— 直观感受这组价格贵不贵
  const typical = (10000 * num("input") + 40000 * num("cacheRead") + 2000 * num("output")) / 1e6;

  return (
    <>
      <div className={`grid gap-2 ${stacked ? "grid-cols-2" : "grid-cols-4"}`}>
        {COST_MAIN_KEYS.map((k) => (
          <label key={k} className="flex flex-col gap-1">
            <span className="text-mini text-[var(--fg-4)]">{COST_LABELS[k]}</span>
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-label text-[var(--fg-4)]">
                $
              </span>
              <Input
                className={`pl-5 font-mono tabular-nums ${bad[k] ? "!border-[var(--err)]" : ""}`}
                inputMode="decimal"
                value={textOf(k)}
                placeholder="0"
                onChange={(e) => {
                  setDrafts((p) => ({ ...p, [k]: e.target.value }));
                  if (bad[k]) setBad((p) => ({ ...p, [k]: false }));
                }}
                onBlur={() => commit(k)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
                }}
              />
            </div>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-mini text-[var(--fg-4)]">
        {Object.values(bad).some(Boolean) && <FieldError>价格要写成非负数字, 比如 2.5</FieldError>}
        {cost ? (
          <>
            <span>
              典型一轮 (50k 输入其中 40k 命中缓存, 2k 输出) 约{" "}
              <b className="font-mono text-label font-semibold text-[var(--fg-2)]">${typical.toFixed(4)}</b>
            </span>
            <span className="flex-1" />
            <button
              className={LINK}
              onClick={() => {
                setModelField(pid, mid, "cost", null);
                setDrafts({});
                setBad({});
              }}
            >
              清除价格
            </button>
          </>
        ) : (
          <span>未设置价格, 成本统计按 0 计。填任意一格即可, 其余自动补 0。</span>
        )}
      </div>
    </>
  );
}
