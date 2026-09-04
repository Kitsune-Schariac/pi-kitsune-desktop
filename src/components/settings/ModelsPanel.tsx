import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  FileJson,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  Button,
  Input,
  Select,
} from "../ui";
import {
  COMPAT_FLAGS,
  COST_MAIN_KEYS,
  isObj,
  modelOf,
  overridesOf,
  providerIds,
  providerOf,
  providersOf,
  rawModelsOf,
  THINKING_LEVELS,
  useModelsConfigStore,
} from "../../store/modelsConfig";

// pi 支持的 api 全量取值 (docs/custom-provider.md Supported APIs)。下拉给全量而不是只给
// 常用 4 个: 后端校验按全量放行, 前端缩窄只会挡住 azure / vertex 这类合法配置。
const API_VALUES = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
];

const INPUT_KINDS = ["text", "image"] as const;
// 已知的模态档位之外还可能躺着 pi 未来新增的取值 (如 audio), 它们不是本版本认识的,
// 但仍是用户数据: 判定只用于「已知项排前、未知项原样保留」, 不用于过滤。
const isKnownInput = (x: unknown): boolean =>
  typeof x === "string" && (INPUT_KINDS as readonly string[]).includes(x);

// cost 四个主键 + 显示名; tiers 是费率阶梯数组, 不做逐项控件 (留在 JSON 区保真)
const COST_LABELS: Record<string, string> = {
  input: "输入",
  output: "输出",
  cacheRead: "缓存读",
  cacheWrite: "缓存写",
};

// 思考档位显示名 (与档位名相同, 保留常量以便日后改中文/缩写)
const LEVEL_LABELS: Record<string, string> = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

// 主题变量驱动的控件底色: 卡片上的输入框凹陷一档 (raised 卡片 → sunken 输入),
// 左栏 (sunken 底) 上的输入框反过来用 base。一律走变量, 明暗两套皮肤都成立。
// placeholder 用 neutral-500 而不是 400: 暗色下色阶反转后 400 只有 113 灰, 压在深底输入框上
// 对比度约 4.3:1, 小字号偏糊; 500 反转后是 161 灰, 提到 7:1 上下, 且浅色下仍是「比正文弱一档」
const FIELD_BASE =
  "w-full rounded-md border px-2 py-2 text-xs text-neutral-800 outline-none transition duration-fast ease-out placeholder:text-neutral-500 focus:border-[var(--primary-400)]";
const FIELD_ON_CARD = `${FIELD_BASE} border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)]`;
const FIELD_ON_COL = `${FIELD_BASE} border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-base)_calc(var(--overlay-alpha)_*_100%),transparent)]`;

const BTN_GHOST =
  "inline-flex items-center gap-2 rounded-md border border-[var(--border-subtle)] px-2 py-2 text-xs text-neutral-600 transition duration-fast ease-out hover:border-[var(--border-strong)] hover:bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40";
const BTN_PRIMARY =
  "inline-flex items-center gap-2 rounded-md bg-[var(--primary-500)] px-3 py-2 text-xs font-medium text-white transition duration-fast ease-out hover:bg-[var(--primary-600)] disabled:cursor-not-allowed disabled:opacity-40";
const BTN_DANGER =
  "inline-flex items-center gap-2 rounded-md border border-[var(--border-subtle)] px-2 py-2 text-xs text-red-500 transition duration-fast ease-out hover:border-red-500 hover:bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)]";

const textOf = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const numTextOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** 上下文长度徽标: 200000 → 200k, 2000000 → 2M */
function formatCtx(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  if (v >= 1_000_000) return `${v % 1_000_000 === 0 ? v / 1_000_000 : (v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${v % 1000 === 0 ? v / 1000 : (v / 1000).toFixed(1)}k`;
  return String(v);
}

/**
 * 分区卡片。设置窗已改成全屏视图, 右栏可用宽度远大于原来的半格模态, 靠分区标题 + 说明
 * 把「models[] 与 modelOverrides 是两条语义不同的通道」讲清楚, 比堆字段重要。
 */
function Section({
  icon: Icon,
  title,
  desc,
  actions,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  desc?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-raised)_calc(var(--overlay-alpha)_*_100%),transparent)]">
      <header className="flex items-start gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--faint)]" />
        <div className="min-w-0 flex-1">
          <h3 className="text-title font-semibold text-[var(--fg)]">{title}</h3>
          {desc && (
            <p className="mt-1 text-mini leading-relaxed text-[var(--muted)]">{desc}</p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** 字段标签; 说明性文字统一 text-xs, 与正文 text-xs 拉开层级 */
function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
      {children}
      {hint && <span className="text-xs text-neutral-400">{hint}</span>}
    </span>
  );
}

// 徽章: 同一行里只允许一种几何 (高度 / 圆角 / 内边距 / 字号全部相同), 语义层级只靠颜色
// 区分 —— 形状一多, 「推理 / 文本 / 131.1k 上下文」看着就像三种不同的控件而不是一组属性。
// 中性档用 neutral-600 而不是 500: 暗色皮肤下整条色阶反转, 600 反而比 500 亮一档,
// 深灰底上的次要文字才不糊。
const BADGE_BASE =
  "inline-flex h-5 shrink-0 items-center rounded-md border px-2 text-xs leading-none";
const BADGE_ACCENT = `${BADGE_BASE} border-[var(--primary-400)] text-[var(--primary-600)]`;
// 中性档用 border-strong 而不是 border-subtle: subtle 在卡片底上几乎是隐形的, 结果只有
// 蓝色那枚看着「有框」, 三枚并排又变回三种形态。不靠底色区分 —— 淡底在暗色下就是浅色块。
const BADGE_NEUTRAL = `${BADGE_BASE} border-[var(--border-strong)] text-neutral-600`;

function Badge({
  tone = "neutral",
  className = "",
  children,
}: {
  /** accent = 需要强调的能力; neutral = 常规属性 */
  tone?: "accent" | "neutral";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`${tone === "accent" ? BADGE_ACCENT : BADGE_NEUTRAL} ${className}`}>
      {children}
    </span>
  );
}

/**
 * 长尾字段的 JSON 编辑器 (design §3.2 第 4 项): 受控 textarea, 失焦时 JSON.parse 校验,
 * 非法则原地标红并把错误回传给面板 —— 面板据此禁用保存, 绝不把非法 JSON 落盘。
 * 不引第三方编辑器: 项目已有的 shiki 高亮是给消息流用的, 不为此拉进设置窗。
 *
 * 草稿只在挂载时初始化一次, 重挂载由调用方的 key (含 provider / model / 字段名) 控制。
 * 若改成「value 变化就重灌草稿」, 用户编辑别的字段导致 doc 换新对象时会把正在输入的
 * 半截 JSON 冲掉。
 */
function JsonField({
  label,
  hint,
  value,
  fieldKey,
  rows = 4,
  onError,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: unknown;
  /** 错误槽位键; 切换 provider/模型时旧槽位必须被清掉, 否则保存会被永久禁用 */
  fieldKey: string;
  rows?: number;
  onError: (key: string, msg: string | null) => void;
  /** 提交文本, 返回错误文案 (null = 已写入) */
  onCommit: (text: string) => string | null;
}) {
  const [text, setText] = useState(() =>
    value === undefined || value === null ? "" : JSON.stringify(value, null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => onError(fieldKey, null);
  }, [fieldKey, onError]);

  const commit = () => {
    const err = onCommit(text);
    setError(err);
    onError(fieldKey, err);
  };

  // 已经改对了但还没失焦时, 红字和禁用的保存按钮不该继续留着 —— 否则点「保存」第一下
  // 只触发 blur, 看起来像没反应。只在错误态下试解析 (正常态不打扰输入), 空文本算合法
  // (语义是删键), 且绝不回灌 text: 那会冲掉半截输入, 是本组件刻意保留的行为。
  const onChangeText = (next: string) => {
    setText(next);
    if (!error) return;
    const trimmed = next.trim();
    if (trimmed) {
      try {
        JSON.parse(trimmed);
      } catch {
        return;
      }
    }
    setError(null);
    onError(fieldKey, null);
  };

  return (
    <div>
      {label && (
        <div className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
          <span className="font-mono">{label}</span>
          {hint && <span className="text-xs text-neutral-400">{hint}</span>}
        </div>
      )}
      {/* min-h 兜底等高: 模型级与 provider 级是同类 JSON 编辑器, 只靠 rows 相同仍会因
          内容行数不同而高低参差 */}
      <textarea
        value={text}
        rows={rows}
        spellCheck={false}
        onChange={(e) => onChangeText(e.target.value)}
        onBlur={commit}
        className={`min-h-[88px] w-full resize-y rounded-md border bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] px-2 py-2 font-mono text-xs leading-relaxed text-neutral-800 outline-none transition duration-fast ease-out ${
          error
            ? "border-red-500 focus:border-red-500"
            : "border-[var(--border-subtle)] focus:border-[var(--primary-400)]"
        }`}
      />
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

// 设置窗「模型与供应商」tab: 直接增删改查 pi 的 ~/.pi/agent/models.json。
// 全高两栏: 左栏 provider 列表 (自带搜索), 右栏选中 provider 的分区详情。整份文档在 store
// 里以普通对象承载, 组件只做定点赋值。
//
// 外壳契约: SettingsWindow 把本组件直接塞进 `flex-1 min-h-0 overflow-hidden` 容器, 不套
// padding 也不套滚动容器 —— 根节点必须自己撑满高度并各自管理滚动, 否则全高布局会塌。
export function ModelsPanel() {
  const doc = useModelsConfigStore((s) => s.doc);
  const path = useModelsConfigStore((s) => s.path);
  const exists = useModelsConfigStore((s) => s.exists);
  const parseError = useModelsConfigStore((s) => s.parseError);
  const dirty = useModelsConfigStore((s) => s.dirty);
  const selectedProvider = useModelsConfigStore((s) => s.selectedProvider);
  const selectedModelId = useModelsConfigStore((s) => s.selectedModelId);
  const saveError = useModelsConfigStore((s) => s.saveError);
  const savedNotice = useModelsConfigStore((s) => s.savedNotice);
  const loading = useModelsConfigStore((s) => s.loading);
  const saving = useModelsConfigStore((s) => s.saving);

  const load = useModelsConfigStore((s) => s.load);
  const save = useModelsConfigStore((s) => s.save);
  const dismissNotice = useModelsConfigStore((s) => s.dismissNotice);
  const selectProvider = useModelsConfigStore((s) => s.selectProvider);
  const selectModel = useModelsConfigStore((s) => s.selectModel);
  const createInitialDoc = useModelsConfigStore((s) => s.createInitialDoc);
  const setProviderField = useModelsConfigStore((s) => s.setProviderField);
  const addProvider = useModelsConfigStore((s) => s.addProvider);
  const renameProvider = useModelsConfigStore((s) => s.renameProvider);
  const deleteProvider = useModelsConfigStore((s) => s.deleteProvider);
  const setProviderJson = useModelsConfigStore((s) => s.setProviderJson);
  const addModel = useModelsConfigStore((s) => s.addModel);
  const deleteModel = useModelsConfigStore((s) => s.deleteModel);
  const deleteModelAt = useModelsConfigStore((s) => s.deleteModelAt);
  const renameModel = useModelsConfigStore((s) => s.renameModel);
  const setModelField = useModelsConfigStore((s) => s.setModelField);
  const setModelNumber = useModelsConfigStore((s) => s.setModelNumber);
  const setModelCostText = useModelsConfigStore((s) => s.setModelCostText);
  const setModelLevelEntry = useModelsConfigStore((s) => s.setModelLevelEntry);
  const setModelCompatFlag = useModelsConfigStore((s) => s.setModelCompatFlag);
  const setModelJson = useModelsConfigStore((s) => s.setModelJson);
  const addModelOverride = useModelsConfigStore((s) => s.addModelOverride);
  const deleteModelOverride = useModelsConfigStore((s) => s.deleteModelOverride);
  const setModelOverrideJson = useModelsConfigStore((s) => s.setModelOverrideJson);

  // 面板每次挂载 (切进该 tab) 拉一次快照, 拿新 mtime 续乐观锁。
  // 已有未保存改动时 store 会跳过这次自动加载 —— 切走 tab 会卸载面板, 重载等于无声丢改动。
  useEffect(() => {
    void load();
  }, [load]);

  // 非法 JSON 槽位记录: 非空即禁用保存 (R3)。卸载时清槽, 切换选中项不残留旧错误
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  const setJsonError = useCallback((key: string, msg: string | null) => {
    setJsonErrors((prev) => {
      if (msg === null) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === msg) return prev;
      return { ...prev, [key]: msg };
    });
  }, []);
  const hasJsonError = Object.keys(jsonErrors).length > 0;

  const [query, setQuery] = useState("");
  const [addingProvider, setAddingProvider] = useState(false);
  const [newProviderId, setNewProviderId] = useState("");
  const [newOverrideKey, setNewOverrideKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  // id 类字段用草稿 + 失焦提交: 边打边改名会不断重建 provider 的键, 中间态还可能撞空串
  const [pidDraft, setPidDraft] = useState("");
  const [midDraft, setMidDraft] = useState("");

  const pid = selectedProvider;
  const provider = providerOf(doc, pid);
  // 模型列表按未过滤的原文数组渲染: 混在 models[] 里的非对象项也是用户数据, 藏起来只会
  // 造成「保存报缺少 id, 但列表里看不见那条」的无从下手局面
  const rawModels = rawModelsOf(doc, pid);
  const model = modelOf(doc, pid, selectedModelId);

  // cost / level 输入框本地草稿 (避免“每键即时解析”吞小数 / 半截值落盘): 失焦才提交。
  // 切换 provider/模型时整体清空; 草稿为空时回退到文档已保存值。
  const modelKey = selectedProvider && selectedModelId ? `${selectedProvider}|${selectedModelId}` : "";
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [levelDraft, setLevelDraft] = useState<Record<string, string>>({});
  // cost 非法输入的红框标记 (keyed by 主键)
  const [costErrors, setCostErrors] = useState<Record<string, boolean>>({});
  const modelCost = isObj(model?.cost) ? model.cost : {};
  useEffect(() => {
    setCostDraft({});
    setLevelDraft({});
    setCostErrors({});
  }, [modelKey]);
  const costTextOf = (k: string) => {
    const draft = costDraft[k];
    if (draft !== undefined) return draft;
    return numTextOf(modelCost[k]);
  };
  const setCostDraftVal = (k: string, v: string) => {
    // 重新输入即清错: 错误只在失焦校验失败时出现
    if (costErrors[k]) setCostErrors((p) => ({ ...p, [k]: false }));
    setCostDraft((p) => ({ ...p, [k]: v }));
  };
  const commitCost = (k: string) => {
    if (!pid || !selectedModelId) return;
    const val = (costDraft[k] ?? "").trim();
    // 原本无 cost 且这次也没输入 → 不创建全 0 的 cost (避免点一下失焦就写脏配置)
    const hadCost = isObj(model?.cost) && Object.keys(model.cost).length > 0;
    if (!hadCost && val === "") return;
    const ok = setModelCostText(pid, selectedModelId, k, val);
    if (ok) {
      setCostErrors((p) => ({ ...p, [k]: false }));
      // 空串在 store 里落为 0: 草稿同步成 "0" 让显示与文档一致 (所见即所得),
      // 否则框里留空、文档是 0, 用户会以为没存上
      setCostDraft((p) => ({ ...p, [k]: val === "" ? "0" : val }));
    } else {
      // 非法输入 (非数字/负数) 不落盘: 红框提示 + 回退草稿到文档已保存值
      setCostErrors((p) => ({ ...p, [k]: true }));
      setCostDraft((p) => ({ ...p, [k]: numTextOf(modelCost[k]) }));
    }
  };
  // level 自定义值: 输入进草稿, 失焦才 setModelLevelEntry
  const levelTextOf = (level: string) => {
    const d = levelDraft[level];
    if (d !== undefined) return d;
    const v = isObj(model?.thinkingLevelMap) ? model.thinkingLevelMap[level] : undefined;
    return typeof v === "string" ? v : "";
  };
  const setLevelDraftVal = (level: string, v: string) => setLevelDraft((p) => ({ ...p, [level]: v }));

  // compat JSON 编辑区与可视开关同屏编辑同一个 compat 对象: JsonField 草稿只在挂载时
  // 初始化一次, 可视开关改 compat 后旧 JSON 草稿就过期了 (再失焦会用旧内容覆盖新开关)。
  // 用 compatRev / levelRev 驱动对应 JsonField 重挂载 (仅该键), 其它字段不受影响。
  const [compatRev, setCompatRev] = useState(0);
  const bumpCompatRev = () => setCompatRev((r) => r + 1);
  const [levelRev, setLevelRev] = useState(0);
  const bumpLevelRev = () => setLevelRev((r) => r + 1);
  // 可视档位编辑统一入口: 写文档 + bump JSON 区 rev + 清该档草稿
  const onLevelChange = (level: string, value: string | null | undefined) => {
    if (!pid || !selectedModelId) return;
    setLevelDraft((p) => {
      if (!(level in p)) return p;
      const n = { ...p };
      delete n[level];
      return n;
    });
    setModelLevelEntry(pid, selectedModelId, level, value);
    bumpLevelRev();
  };
  // 可视开关 onchange 里同步 bump (见下方 COMPAT_FLAGS 行)
  const onCompatFlag = (flag: string, val: string) => {
    if (pid && selectedModelId) {
      setModelCompatFlag(pid, selectedModelId, flag, val === "default" ? undefined : val === "true");
      bumpCompatRev();
    }
  };
  const commitLevel = (level: string) => {
    if (!pid || !selectedModelId) return;
    const val = (levelDraft[level] ?? "").trim();
    // 输入框空 = 回默认映射: 删掉该档显式条目 (省略)。与 × 同语义。
    onLevelChange(level, val || undefined);
  };

  // input[] 原文, 用于保留未知取值 (见下方复选框)
  const modelInputRaw: unknown[] = model && Array.isArray(model.input) ? model.input : [];
  const modelInputKnown = modelInputRaw.filter(isKnownInput) as string[];
  const modelInputUnknown = modelInputRaw.filter((x) => !isKnownInput(x));
  const overrides = overridesOf(doc, pid);
  const isConflict = !!saveError && saveError.includes("mtime 冲突");

  useEffect(() => setShowApiKey(false), [pid]);
  useEffect(() => setPidDraft(pid ?? ""), [pid]);
  useEffect(() => setMidDraft(selectedModelId ?? ""), [selectedModelId]);

  const onReload = () => {
    if (dirty && !window.confirm("放弃未保存的修改并重新加载配置？")) return;
    void load();
  };

  // 删除在保存后不可恢复, 而删除按钮是 hover 图标且紧贴名称按钮, 误点代价高。
  // 沿用 onReload 已有的 window.confirm 惯例, 不引新依赖; 文案写清连带影响。
  const confirmAnd = (message: string, run: () => void) => {
    if (window.confirm(message)) run();
  };

  const onAddProvider = () => {
    const id = newProviderId.trim();
    if (!id || !addProvider(id)) return;
    setNewProviderId("");
    setAddingProvider(false);
  };

  const commitPid = () => {
    const next = pidDraft.trim();
    if (!pid || next === pid) return;
    // 空或与现有 id 冲突 → 回滚草稿, 让输入框回到真实 id
    if (!next || !renameProvider(pid, next)) setPidDraft(pid);
  };

  const commitMid = () => {
    const next = midDraft.trim();
    if (!pid || !selectedModelId || next === selectedModelId) return;
    if (!next || !renameModel(pid, selectedModelId, next)) setMidDraft(selectedModelId);
  };

  const onAddOverride = () => {
    const key = newOverrideKey.trim();
    if (!pid || !key || !addModelOverride(pid, key)) return;
    setNewOverrideKey("");
  };

  const apiKeyValue = textOf(provider.apiKey);
  const isEnvRef = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(apiKeyValue);
  const isCommandRef = apiKeyValue.startsWith("!");
  // 环境变量引用 / 命令取值不是密钥本身, 遮蔽只会妨碍核对; 其余按裸密钥遮蔽
  const maskApiKey = !isEnvRef && !isCommandRef;

  // 左侧过滤: 按 provider id / name 大小写不敏感匹配
  const q = query.trim().toLowerCase();
  const providerEntries = Object.entries(providersOf(doc)).filter(([id, raw]) => {
    if (!q) return true;
    const name = isObj(raw) ? textOf(raw.name).toLowerCase() : "";
    return id.toLowerCase().includes(q) || name.includes(q);
  });

  // 顶部工具条状态徽标: 未保存 / 已保存 / 文件损坏 —— 保存后到底生效没有, 必须在第一屏
  // 就能看到, 否则用户会以为「明明保存了却没变化」
  const statusBadge = parseError ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-red-500 px-2 py-1 text-xs text-red-500">
      <AlertTriangle className="h-3 w-3" />
      文件损坏
    </span>
  ) : dirty ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500 px-2 py-1 text-xs text-amber-500">
      未保存
    </span>
  ) : doc ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--border-subtle)] px-2 py-1 text-xs text-neutral-400">
      <Check className="h-3 w-3" />
      已保存
    </span>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface-base)]">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-[var(--border-subtle)] px-6">
        <div className="flex min-w-0 items-center gap-2">
          <FileJson className="h-4 w-4 shrink-0 text-neutral-400" />
          <span
            className="truncate font-mono text-xs text-neutral-500"
            title={path || undefined}
          >
            {path || "~/.pi/agent/models.json"}
          </span>
          {statusBadge}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            onClick={onReload}
            disabled={loading}
            variant="ghost"
            title="重新加载并放弃本地未保存的修改"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            重新加载
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!dirty || saving || hasJsonError || !!parseError}
            variant="primary"
          >
            <Save className="h-4 w-4" />
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </header>

      {savedNotice && (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] px-6 py-2 text-xs text-neutral-600">
          <Check className="mt-1 h-4 w-4 shrink-0 text-primary-600" />
          <span className="min-w-0 flex-1">{savedNotice}</span>
          <button
            onClick={dismissNotice}
            className="shrink-0 text-xs text-neutral-400 transition duration-fast ease-out hover:text-neutral-700"
          >
            知道了
          </button>
        </div>
      )}

      {saveError && (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] px-6 py-2 text-xs text-red-500">
          <AlertTriangle className="mt-1 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p>{saveError}</p>
            {isConflict && (
              <button
                onClick={() => void load()}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-red-500 px-2 py-1 text-xs text-red-500 transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)]"
              >
                <RefreshCw className="h-3 w-3" />
                放弃本地改动并重新加载
              </button>
            )}
          </div>
        </div>
      )}

      {loading && !doc ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-neutral-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在读取配置…
        </div>
      ) : parseError ? (
        // 文件存在但 JSON 非法: 展示明确错误并禁用全部写操作。
        // 绝不能以空配置覆盖用户的坏文件 —— 那份文件里可能有 GUI 看不懂但 pi 认的配置。
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl">
            <div className="flex items-start gap-2 rounded-md border border-red-500 bg-[color-mix(in_oklch,var(--surface-raised)_calc(var(--overlay-alpha)_*_100%),transparent)] p-4">
              <AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-red-500" />
              <div className="min-w-0 space-y-2">
                <p className="text-sm font-medium text-red-500">
                  models.json 无法解析, 已禁用全部编辑
                </p>
                <p className="break-all font-mono text-xs text-red-500">{parseError}</p>
                <p className="text-xs leading-relaxed text-neutral-500">
                  请在外部编辑器修复后点击「重新加载」。为保护你的配置, 此状态下不会覆盖原文件。
                </p>
              </div>
            </div>
            <p className="mt-3 break-all font-mono text-xs text-neutral-500">{path}</p>
          </div>
        </div>
      ) : !doc ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <FileJson className="h-8 w-8 text-neutral-400" />
          <div>
            <p className="text-sm text-neutral-700">尚未创建 models.json</p>
            <p className="mt-1 break-all font-mono text-xs text-neutral-500">{path}</p>
          </div>
          <button onClick={createInitialDoc} className={BTN_PRIMARY}>
            <Plus className="h-4 w-4" />
            创建初始配置
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左栏: provider 列表 + 搜索 + 新增 */}
          <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)]">
            <div className="shrink-0 border-b border-[var(--border-subtle)] p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索 provider id 或名称"
                  className={`${FIELD_ON_COL} pl-8`}
                />
              </div>
            </div>

            <div className="flex-1 space-y-1 overflow-y-auto p-2">
              {providerIds(doc).length === 0 && (
                <p className="px-2 py-6 text-center text-xs leading-relaxed text-neutral-400">
                  暂无 provider, 点击下方按钮新增
                </p>
              )}
              {providerIds(doc).length > 0 && providerEntries.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-neutral-400">
                  没有匹配「{query.trim()}」的 provider
                </p>
              )}
              {providerEntries.map(([id, raw]) => {
                const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
                const active = id === pid;
                const modelCount = rawModelsOf(doc, id).length;
                return (
                  <div
                    key={id}
                    className={`group relative rounded-md border px-2 py-2 transition duration-fast ease-out ${
                      active
                        ? "border-[var(--border-subtle)] bg-[color-mix(in_oklch,var(--surface-raised)_calc(var(--overlay-alpha)_*_100%),transparent)]"
                        : "border-transparent hover:border-[var(--border-strong)]"
                    }`}
                  >
                    {/* 选中指示条: 2px primary 竖条, 比整块换底色更省视觉预算 */}
                    {active && (
                      <span className="absolute inset-y-2 left-0 w-1 rounded-full bg-[var(--primary-500)]" />
                    )}
                    <button
                      onClick={() => selectProvider(id)}
                      className="w-full text-left"
                      title={id}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-800">
                          {id}
                        </span>
                        {active && (
                          <Check className="h-4 w-4 shrink-0 text-primary-600" />
                        )}
                      </div>
                      {textOf(p.name) && (
                        <div className="mt-1 truncate text-xs text-neutral-500">
                          {textOf(p.name)}
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
                        <span>{modelCount} 模型</span>
                        <span
                          className="inline-flex"
                          title={p.apiKey ? "已配置 apiKey" : "未配置 apiKey"}
                        >
                          <KeyRound
                            className={`h-4 w-4 ${
                              p.apiKey ? "text-primary-500" : "text-neutral-400"
                            }`}
                          />
                        </span>
                      </div>
                    </button>
                    {/* 常驻占位 (仅 hover 显形) 以免 hover 时列表行跳动 */}
                    <button
                      onClick={() =>
                        confirmAnd(
                          `删除 provider「${id}」?\n\n` +
                            `将连带删除其下 ${modelCount} 个自定义模型与 ` +
                            `${Object.keys(overridesOf(doc, id)).length} 个内置模型覆盖项。\n` +
                            `保存前可用「重新加载」撤销, 保存后不可恢复。`,
                          () => deleteProvider(id),
                        )
                      }
                      className="absolute bottom-2 right-2 rounded-sm p-1 text-neutral-400 opacity-0 transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] hover:text-red-500 group-hover:opacity-100"
                      title="删除 provider"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="shrink-0 border-t border-[var(--border-subtle)] p-2">
              {addingProvider ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={newProviderId}
                    onChange={(e) => setNewProviderId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onAddProvider();
                      if (e.key === "Escape") {
                        setNewProviderId("");
                        setAddingProvider(false);
                      }
                    }}
                    placeholder="provider id"
                    className={`${FIELD_ON_COL} min-w-0 flex-1`}
                  />
                  <button
                    onClick={onAddProvider}
                    disabled={!newProviderId.trim()}
                    className="shrink-0 rounded-md border border-[var(--border-subtle)] p-2 text-neutral-500 transition duration-fast ease-out hover:border-[var(--primary-400)] hover:text-primary-600 disabled:opacity-40"
                    title="确认新增"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => {
                      setNewProviderId("");
                      setAddingProvider(false);
                    }}
                    className="shrink-0 rounded-md border border-[var(--border-subtle)] p-2 text-neutral-400 transition duration-fast ease-out hover:text-neutral-700"
                    title="取消"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setAddingProvider(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-[var(--border-strong)] px-2 py-2 text-xs text-neutral-500 transition duration-fast ease-out hover:border-[var(--primary-400)] hover:text-neutral-800"
                >
                  <Plus className="h-4 w-4" />
                  新增 provider
                </button>
              )}
            </div>
          </aside>

          {/* 右栏: 选中 provider 的分区详情 */}
          <div className="flex-1 overflow-y-auto p-6">
            {!pid ? (
              <p className="pt-16 text-center text-xs text-neutral-500">
                在左侧选择或新增一个 provider
              </p>
            ) : (
              <div className="mx-auto max-w-4xl space-y-5">
                {/* 连接: provider 常用字段 (R2) */}
                <Section icon={Plug} title="连接">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <label className="block">
                      <FieldLabel>provider id</FieldLabel>
                      <input
                        value={pidDraft}
                        onChange={(e) => setPidDraft(e.target.value)}
                        onBlur={commitPid}
                        className={FIELD_ON_CARD}
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>name</FieldLabel>
                      <input
                        value={textOf(provider.name)}
                        onChange={(e) => setProviderField(pid, "name", e.target.value)}
                        className={FIELD_ON_CARD}
                      />
                    </label>
                    <label className="col-span-2 block">
                      <FieldLabel>baseUrl</FieldLabel>
                      <input
                        value={textOf(provider.baseUrl)}
                        onChange={(e) => setProviderField(pid, "baseUrl", e.target.value)}
                        placeholder="https://api.example.com/v1"
                        className={FIELD_ON_CARD}
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>api</FieldLabel>
                      <select
                        value={textOf(provider.api)}
                        onChange={(e) => setProviderField(pid, "api", e.target.value)}
                        className={FIELD_ON_CARD}
                      >
                        <option value="">(未设置 · 沿用默认)</option>
                        {API_VALUES.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <FieldLabel>authHeader</FieldLabel>
                      <input
                        value={textOf(provider.authHeader)}
                        onChange={(e) => setProviderField(pid, "authHeader", e.target.value)}
                        placeholder="默认 x-api-key / Authorization"
                        className={FIELD_ON_CARD}
                      />
                    </label>
                  </div>
                </Section>

                {/* 凭据: apiKey 三态 (design §3.3) */}
                <Section
                  icon={KeyRound}
                  title="凭据"
                  desc="支持直接填裸密钥, 也支持 $ENV_VAR / ${ENV_VAR} 环境变量引用与 !command 命令取值。密钥明文保存在 models.json 中, 本面板不做联网校验。"
                >
                  {/* 单字段分区, 输入框走全宽: 收窄成六成宽会在全宽 baseUrl 与两列网格之间
                      多出一块无主的空白 */}
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs text-neutral-500">
                      <span>apiKey</span>
                      {isEnvRef && <Badge tone="accent">环境变量引用</Badge>}
                      {isCommandRef && <Badge tone="accent">命令取值</Badge>}
                    </div>
                    <div className="relative">
                      <input
                        type={maskApiKey && !showApiKey ? "password" : "text"}
                        value={apiKeyValue}
                        onChange={(e) => setProviderField(pid, "apiKey", e.target.value)}
                        placeholder="sk-... 或 $ENV_VAR 或 !command"
                        className={`${FIELD_ON_CARD} pr-9`}
                      />
                      {maskApiKey && (
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 transition duration-fast ease-out hover:text-neutral-700"
                          title={showApiKey ? "隐藏" : "显示"}
                        >
                          {showApiKey ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                </Section>

                {/* 自定义模型 (models[]): 与 modelOverrides 语义不同, 必须分区呈现 (prd 事实 3) */}
                <Section
                  icon={Boxes}
                  title="自定义模型 models[]"
                  desc="与内置模型按 id 合并, 同 id 覆盖内置; 新 id 追加。删除这里的条目不会移除内置模型。"
                  actions={
                    <Button onClick={() => addModel(pid)} variant="ghost">
                      <Plus className="h-4 w-4" />
                      新增模型
                    </Button>
                  }
                >
                  {rawModels.length === 0 ? (
                    <p className="text-xs text-neutral-400">
                      暂无自定义模型, 点击右上「新增模型」添加
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {rawModels.map((m, i) => {
                        // 非对象项 (字符串 / null / ...) 不是合法模型, 后端校验会拒; 但它是用户
                        // 数据, 不渲染等于替用户做了删除决定, 且报错时用户看不见那条无从修起。
                        // 因此照常显示, 标成非法项并给删除入口。
                        if (!isObj(m)) {
                          const preview = JSON.stringify(m) ?? String(m);
                          return (
                            <div
                              key={`illegal:${i}`}
                              className="flex items-center gap-2 rounded-md border border-dashed border-red-500 px-3 py-2"
                            >
                              <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
                              <span className="shrink-0 text-xs text-red-500">非法项</span>
                              <span
                                className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500"
                                title={`非法项: ${preview} —— 缺少非空 id, 后端会拒绝保存; 请在此删除或在外部编辑器修正`}
                              >
                                {preview}
                              </span>
                              <button
                                onClick={() =>
                                  confirmAnd(
                                    `删除这个非法项?\n\n${preview}\n\n它不是合法模型 (缺少非空 id), 后端会拒绝保存。`,
                                    () => deleteModelAt(pid, i),
                                  )
                                }
                                className="shrink-0 text-neutral-400 transition duration-fast ease-out hover:text-red-500"
                                title="删除该非法项"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          );
                        }
                        const mid = textOf(m.id);
                        const active = mid === selectedModelId;
                        const ctx = formatCtx(m.contextWindow);
                        const inputs = Array.isArray(m.input)
                          ? (m.input.filter((x) => typeof x === "string") as string[])
                          : [];
                        return (
                          <div
                            key={`model:${i}:${mid}`}
                            className={`rounded-md border transition duration-fast ease-out ${
                              active
                                ? "border-[var(--border-strong)]"
                                : "border-[var(--border-subtle)] hover:border-[var(--border-strong)]"
                            }`}
                          >
                            <div className="flex items-center gap-2 px-3 py-2">
                              <button
                                onClick={() => selectModel(active ? null : mid)}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                title={mid}
                              >
                                {active ? (
                                  <ChevronUp className="h-4 w-4 shrink-0 text-neutral-400" />
                                ) : (
                                  <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
                                )}
                                <span className="min-w-0 truncate font-mono text-xs font-medium text-neutral-800">
                                  {mid}
                                </span>
                                {textOf(m.name) && (
                                  <span className="min-w-0 truncate text-xs text-neutral-500">
                                    {textOf(m.name)}
                                  </span>
                                )}
                                <span className="ml-auto flex shrink-0 items-center gap-2">
                                  {m.reasoning === true && <Badge tone="accent">推理</Badge>}
                                  {inputs.map((k, ki) => (
                                    <Badge key={`${k}:${ki}`}>
                                      {k === "image" ? "图像" : k === "text" ? "文本" : k}
                                    </Badge>
                                  ))}
                                  {ctx && <Badge className="tabular-nums">{ctx} 上下文</Badge>}
                                </span>
                              </button>
                              {/* 删除入口放卡片头部 actions 位: 留在展开区底部会在最后一个字段组
                                  与按钮之间压出大片空白, 且折叠状态下删不掉 */}
                              <button
                                onClick={() =>
                                  confirmAnd(
                                    `删除自定义模型「${mid}」?\n\n` +
                                      `只移除这里的条目, 不影响同名内置模型。\n` +
                                      `保存前可用「重新加载」撤销, 保存后不可恢复。`,
                                    () => deleteModel(pid, mid),
                                  )
                                }
                                className={`${BTN_DANGER} shrink-0`}
                                title="删除该模型"
                              >
                                <Trash2 className="h-4 w-4" />
                                删除
                              </button>
                            </div>

                            {active && model && (
                              <div className="space-y-4 border-t border-[var(--border-subtle)] px-3 py-4">
                                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                                  <label className="block">
                                    <FieldLabel>id (必填)</FieldLabel>
                                    <input
                                      value={midDraft}
                                      onChange={(e) => setMidDraft(e.target.value)}
                                      onBlur={commitMid}
                                      className={FIELD_ON_CARD}
                                    />
                                  </label>
                                  <label className="block">
                                    <FieldLabel>name</FieldLabel>
                                    <input
                                      value={textOf(model.name)}
                                      onChange={(e) =>
                                        setModelField(pid, selectedModelId, "name", e.target.value)
                                      }
                                      className={FIELD_ON_CARD}
                                    />
                                  </label>
                                  <label className="block">
                                    <FieldLabel>contextWindow</FieldLabel>
                                    <input
                                      value={numTextOf(model.contextWindow)}
                                      onChange={(e) =>
                                        setModelNumber(
                                          pid,
                                          selectedModelId,
                                          "contextWindow",
                                          e.target.value,
                                        )
                                      }
                                      placeholder="200000"
                                      className={FIELD_ON_CARD}
                                    />
                                  </label>
                                  <label className="block">
                                    <FieldLabel>maxTokens</FieldLabel>
                                    <input
                                      value={numTextOf(model.maxTokens)}
                                      onChange={(e) =>
                                        setModelNumber(pid, selectedModelId, "maxTokens", e.target.value)
                                      }
                                      placeholder="8192"
                                      className={FIELD_ON_CARD}
                                    />
                                  </label>
                                </div>

                                {/* 两组独立勾选, 分组靠「小标题 + 一致的组内间距」建立: 靠不等
                                    间距暗示会让裸文字 input 看着像漏了勾选框的字段 */}
                                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-neutral-500">能力</span>
                                    <label
                                      className="flex items-center gap-2 text-xs text-neutral-600"
                                      title="reasoning: 该模型支持扩展思考"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={model.reasoning === true}
                                        onChange={(e) =>
                                          setModelField(
                                            pid,
                                            selectedModelId,
                                            "reasoning",
                                            e.target.checked ? true : null,
                                          )
                                        }
                                      />
                                      reasoning
                                    </label>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-neutral-500">输入类型</span>
                                    {INPUT_KINDS.map((kind) => {
                                      const checked = modelInputKnown.includes(kind);
                                      return (
                                        <label
                                          key={kind}
                                          className="flex items-center gap-2 text-xs text-neutral-600"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => {
                                              const set = new Set(modelInputKnown);
                                              if (set.has(kind)) set.delete(kind);
                                              else set.add(kind);
                                              // 已知档按固定顺序排前, 未知取值原样接在后面 —— 只按
                                              // text/image 重建会把 pi 未来新增的模态静默抹掉
                                              const next = [
                                                ...INPUT_KINDS.filter((k) => set.has(k)),
                                                ...modelInputUnknown,
                                              ];
                                              setModelField(
                                                pid,
                                                selectedModelId,
                                                "input",
                                                next.length ? next : null,
                                              );
                                            }}
                                          />
                                          {kind}
                                        </label>
                                      );
                                    })}
                                  </div>
                                </div>

                                {/* cost 四项: 本地草稿 + 失焦提交, 输小数不吞点; 清空 = 0 不删键 */}
                                <div>
                                  <div className="mb-1 flex items-center justify-between gap-2">
                                    <FieldLabel hint="每百万 token; 留空视为 0, 非法输入不生效">
                                      cost
                                    </FieldLabel>
                                    {(() => {
                                      const mc = model?.cost;
                                      return !!mc && isObj(mc) && Object.keys(mc).length > 0;
                                    })() && (
                                      <button
                                          onClick={() =>
                                            confirmAnd(
                                              `删除该模型的 cost (含 tiers)?\n\n` +
                                                `价格信息清空后 pi 按默认全零计费。`,
                                              () => {
                                                setModelField(pid, selectedModelId, "cost", null);
                                                // 清掉本地草稿, 避免残留值在下次编辑时被重新提交
                                                setCostDraft({});
                                              },
                                            )
                                          }
                                          className="shrink-0 text-xs text-neutral-400 transition duration-fast ease-out hover:text-red-500"
                                        >
                                          清除价格
                                        </button>
                                      )}
                                  </div>
                                  <div className="grid grid-cols-4 gap-2">
                                    {COST_MAIN_KEYS.map((k) => {
                                      const label = COST_LABELS[k];
                                      const err = costErrors[k];
                                      return (
                                        <label key={k} className="block">
                                          <span className="mb-1 block text-xs text-neutral-400">
                                            {label}
                                          </span>
                                          <input
                                            value={costTextOf(k)}
                                            onChange={(e) => setCostDraftVal(k, e.target.value)}
                                            onBlur={() => commitCost(k)}
                                            placeholder="0"
                                            inputMode="decimal"
                                            title={err ? "请输入非负数字 (如 2.5 / 0.05 / 0)" : undefined}
                                            className={`${FIELD_ON_CARD} ${
                                              err ? "border-red-500 focus:border-red-500" : ""
                                            }`}
                                          />
                                          {err && (
                                            <span className="mt-0.5 block text-xs text-red-500">
                                              非负数字才有效
                                            </span>
                                          )}
                                        </label>
                                      );
                                    })}
                                  </div>
                                  <p className="mt-1 text-xs text-neutral-400">
                                    空值按 0 保存, 四项齐全才能通过 pi 启动校验
                                  </p>
                                </div>

                                {/* 思考档位映射 (B 方案): 每档 = 档名 + 映射值输入框 (空 = 默认映射) + × 叉 (删该条回默认)。
                                    null = 显式不支持, 不在可视区编辑 (见 JSON), 显示禁用态不误导 */}
                                <div>
                                  <div className="mb-1 flex items-center justify-between gap-2">
                                    <FieldLabel hint="空 = 用 pi 默认映射; 填 = 发给 provider 的值; null (不支持) 见下方 JSON">
                                      thinkingLevelMap
                                    </FieldLabel>
                                    {isObj(model.thinkingLevelMap) &&
                                      Object.keys(model.thinkingLevelMap).length > 0 && (
                                        <button
                                          onClick={() =>
                                            confirmAnd(
                                              `清除该模型的 thinkingLevelMap?\n\n` +
                                                `所有档位恢复为 pi 默认映射 (不再写该键)。`,
                                              () => {
                                                setLevelDraft({});
                                                setModelField(
                                                  pid,
                                                  selectedModelId,
                                                  "thinkingLevelMap",
                                                  null,
                                                );
                                                bumpLevelRev();
                                              },
                                            )
                                          }
                                          className="shrink-0 text-xs text-neutral-400 transition duration-fast ease-out hover:text-red-500"
                                        >
                                          清除映射
                                        </button>
                                      )}
                                  </div>
                                  <div className="space-y-1">
                                    {THINKING_LEVELS.map((level) => {
                                      const v = isObj(model.thinkingLevelMap)
                                        ? model.thinkingLevelMap[level]
                                        : undefined;
                                      // 该档是否已有显式自定义值 (字符串)
                                      const custom = typeof v === "string";
                                      // 该档显式置 null = 不支持: 输入框禁用, 提示去 JSON
                                      const unsupported = v === null;
                                      // 怪值 (数字/对象) 不进输入框编辑, 原样禁用提示 JSON
                                      const abnormal = v !== undefined && !custom && !unsupported;
                                      return (
                                        <div
                                          key={level}
                                          className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] px-2 py-1"
                                        >
                                          <span className="w-20 shrink-0 font-mono text-xs text-neutral-500">
                                            {LEVEL_LABELS[level]}
                                          </span>
                                          {unsupported || abnormal ? (
                                            <>
                                              <span className="min-w-0 flex-1 truncate text-xs italic text-neutral-400">
                                                {unsupported ? "不支持 (null)" : `值异常 (${String(v)})`}
                                                —— 见下方 JSON 编辑
                                              </span>
                                              <Button
                                                size="sm"
                                                variant="danger"
                                                onClick={() => onLevelChange(level, undefined)}
                                                title={`清除「${level}」的异常值`}
                                              >
                                                清除
                                              </Button>
                                            </>
                                          ) : (
                                            <>
                                              <Input
                                                value={levelTextOf(level)}
                                                onChange={(e) => setLevelDraftVal(level, e.target.value)}
                                                onBlur={() => commitLevel(level)}
                                                placeholder={
                                                  // off~high 默认映射是档名同名; xhigh/max 是 opt-in,
                                                  // 默认不映射 (不写 = 不可用)
                                                  level === "xhigh" || level === "max"
                                                    ? "不写 = 不可用"
                                                    : `默认 ${level}`
                                                }
                                                density="sm"
                                                className="min-w-0 flex-1"
                                              />
                                              {/* 已有自定义值才给叉: 叉 = 删该条显式映射, 回默认 (省略) */}
                                              {custom && (
                                                <button
                                                  onClick={() => onLevelChange(level, undefined)}
                                                  className="shrink-0 rounded-sm p-1 text-neutral-400 transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--surface-sunken)_calc(var(--overlay-alpha)_*_100%),transparent)] hover:text-red-500"
                                                  title={`移除「${level}」的自定义映射, 恢复默认`}
                                                >
                                                  <X className="h-4 w-4" />
                                                </button>
                                              )}
                                            </>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>

                                {/* compat 两个高频开关 (模型级); 其余 compat 键仍在下方 JSON 区保真 */}
                                <div>
                                  <FieldLabel hint="不显式设置 = 由 pi 按 provider 自动探测">
                                    compat
                                  </FieldLabel>
                                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                                    {COMPAT_FLAGS.map((flag) => {
                                      const v = isObj(model.compat) ? model.compat[flag] : undefined;
                                      // 只认 boolean; 手写怪值 (字符串 "true"/数字) 不该被显示成“关闭”误导,
                                      // 给一个占位档提示去 JSON 区处理
                                      const abnormal = v !== undefined && typeof v !== "boolean";
                                      const cur = abnormal
                                        ? "abnormal"
                                        : v === undefined
                                          ? "default"
                                          : v === true
                                            ? "true"
                                            : "false";
                                      const label =
                                        flag === "supportsDeveloperRole"
                                          ? "developer 角色"
                                          : flag === "supportsReasoningEffort"
                                            ? "发送 reasoning_effort"
                                            : flag;
                                      // 下拉收起时显示选中项: 文案要短, 过长会截断。
                                      // 选项值保持英文枚举 (default/true/false), 显示文案精简。
                                      const optionText = {
                                        default: "跟随默认",
                                        true:
                                          flag === "supportsDeveloperRole"
                                            ? "支持 developer"
                                            : "开启 effort",
                                        false:
                                          flag === "supportsDeveloperRole"
                                            ? "不支持 developer"
                                            : "关闭 effort",
                                      } as const;
                                      return (
                                        <div key={flag} className="flex items-center gap-2">
                                          <span className="shrink-0 text-xs text-neutral-600">{label}</span>
                                          <Select
                                            value={cur}
                                            onChange={(e) => onCompatFlag(flag, e.target.value)}
                                            // 不锁死宽度: 原生 select 收起宽度 = 选中项文字宽,
                                            // 固定 w-* 会把长文案截断; min-w 保证最短可点
                                            density="sm"
                                            className="min-w-[7rem]"
                                          >
                                            {abnormal && (
                                              <option value="abnormal" disabled>
                                                值异常 (见下方 JSON)
                                              </option>
                                            )}
                                            <option value="default">{optionText.default}</option>
                                            <option value="true">{optionText.true}</option>
                                            <option value="false">{optionText.false}</option>
                                          </Select>
                                          <span className="font-mono text-micro text-neutral-400">
                                            {flag}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>

                                {/* 模型级长尾字段 (samplingParams / thinkingLevelMap / compat / headers 仍可走 JSON,
                                    thinkingLevelMap 与 compat 的可视区改动会通过 rev 重挂载同步 JSON 草稿) */}
                                <div className="border-t border-[var(--border-subtle)] pt-3">
                                  <p className="mb-2 text-xs text-neutral-600">
                                    模型级高级字段 (JSON, 留空表示删除该键; thinkingLevelMap / compat 已可视, 高级编辑在此)
                                  </p>
                                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                                    {(
                                      [
                                        ["samplingParams", "samplingParams", "temperature 等采样参数"],
                                        ["thinkingLevelMap", "thinkingLevelMap", "原始 JSON (7 档已可视)"],
                                        ["compat", "compat", "其余兼容开关 (已可视的两个见上)"],
                                        ["headers", "headers", "模型级自定义请求头, 覆盖 provider 级 headers"],
                                      ] as const
                                    ).map(([key, label, hint]) => (
                                      <JsonField
                                        key={`${pid}|${selectedModelId}|${key}${
                                          key === "compat" ? `|${compatRev}` : key === "thinkingLevelMap" ? `|${levelRev}` : ""
                                        }`}
                                        fieldKey={`model:${pid}:${selectedModelId}:${key}`}
                                        label={label}
                                        hint={hint}
                                        value={model[key]}
                                        onError={setJsonError}
                                        onCommit={(text) => setModelJson(pid, selectedModelId, key, text)}
                                      />
                                    ))}
                                  </div>
                                </div>

                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Section>

                {/* modelOverrides: 只改内置模型的个别字段, 不替换模型列表 (prd 事实 3) */}
                <Section
                  icon={SlidersHorizontal}
                  title="内置模型覆盖 modelOverrides"
                  desc="只覆盖内置模型的个别字段, 不影响模型列表; 未知的 model id 会被 pi 静默忽略。"
                >
                  {Object.keys(overrides).length === 0 ? (
                    <p className="text-xs text-neutral-400">暂无覆盖项</p>
                  ) : (
                    <div className="space-y-2">
                      {Object.entries(overrides).map(([mid, val]) => (
                        <div
                          key={mid}
                          className="rounded-md border border-[var(--border-subtle)] p-3"
                        >
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span
                              className="min-w-0 truncate font-mono text-xs font-medium text-neutral-700"
                              title={mid}
                            >
                              {mid}
                            </span>
                            <button
                              onClick={() =>
                                pid &&
                                confirmAnd(
                                  `删除内置模型「${mid}」的覆盖项?\n\n` +
                                    `不影响模型本身, 只是不再覆盖它的字段。\n` +
                                    `保存前可用「重新加载」撤销, 保存后不可恢复。`,
                                  () => deleteModelOverride(pid, mid),
                                )
                              }
                              className="shrink-0 rounded-sm p-1 text-neutral-400 transition duration-fast ease-out hover:text-red-500"
                              title="删除该覆盖项"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                          <JsonField
                            // key 必须带 provider: 不同 provider 完全可以 override 同一个内置模型 id,
                            // 而草稿只在挂载时初始化 —— 只按 mid 复用实例会让 A 的草稿贴到 B 上,
                            // 用户点进去再点走即触发 commit, B 的覆盖被 A 的内容静默覆盖
                            key={`override:${pid}:${mid}`}
                            label=""
                            fieldKey={`override:${pid}:${mid}`}
                            value={val}
                            rows={5}
                            onError={setJsonError}
                            onCommit={(text) =>
                              pid ? setModelOverrideJson(pid, mid, text) : "未选中 provider"
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 与本面板其它两列网格同构: 输入框占满一整列, 边缘才和分区内的卡片对齐,
                      而不是留一段说不清的短截 */}
                  <div className="mt-3 grid grid-cols-2 items-center gap-x-4">
                    <input
                      value={newOverrideKey}
                      onChange={(e) => setNewOverrideKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onAddOverride();
                      }}
                      placeholder="内置模型 id"
                      className={FIELD_ON_CARD}
                    />
                    <button
                      onClick={onAddOverride}
                      disabled={!newOverrideKey.trim()}
                      className={`${BTN_GHOST} justify-self-start`}
                    >
                      <Plus className="h-4 w-4" />
                      新增覆盖
                    </button>
                  </div>
                </Section>

                {/* provider 级长尾字段 */}
                <Section
                  icon={Settings2}
                  title="高级 (provider 级)"
                  desc="以下字段随 pi 版本演进, 只做原文编辑; 未列出的键原样保留, 绝不裁剪。"
                >
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    {(
                      [
                        ["compat", "compat", "兼容性开关 (20+)"],
                        ["headers", "headers", "自定义请求头"],
                      ] as const
                    ).map(([key, label, hint]) => (
                      <JsonField
                        key={`${pid}|${key}`}
                        fieldKey={`provider:${pid}:${key}`}
                        label={label}
                        hint={hint}
                        value={provider[key]}
                        onError={setJsonError}
                        onCommit={(text) => setProviderJson(pid, key, text)}
                      />
                    ))}
                  </div>
                </Section>

                {!exists && (
                  <p className="text-xs text-neutral-400">
                    该文件尚不存在, 保存时会新建 (mtime 令牌为 0)。
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
