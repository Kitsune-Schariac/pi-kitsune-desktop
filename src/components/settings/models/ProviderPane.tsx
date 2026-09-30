// 第二栏: 选中供应商的连接信息、测试结果、模型列表、新增模型输入框、高级折叠区。
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Download,
  Eye,
  EyeOff,
  Image,
  LoaderCircle,
  Plug,
  Plus,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  findModelSource,
  isModelChanged,
  isObj,
  modelsOf,
  providerIds,
  providerOf,
  providersOf,
  rawModelsOf,
  useModelsConfigStore,
  type JsonObject,
  type ProbeState,
} from "../../../store/modelsConfig";
import { formatTokenShort } from "../../../lib/tokenCount";
import { Button, Input, Segmented, Select } from "../../ui";
import { FetchModelsDialog } from "./dialogs";
import { API_MAIN, API_MORE, Badge, FieldError, IconButton, LINK, hostOf, probeHint, useEscapeLayer } from "./shared";

type KeyKind = "env" | "cmd" | "raw" | "none";

// pi 的密钥是模板: 串中任意位置的 $NAME / ${NAME} 都会插值 ($$ 是字面 $); 前导 ! 是命令取值
function keyKindOf(v: string): KeyKind {
  if (!v.trim()) return "none";
  if (v.startsWith("!")) return "cmd";
  return /(^|[^$])\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_])/.test(v) ? "env" : "raw";
}
const KEY_KIND_TEXT: Record<KeyKind, string> = { env: "环境变量引用", cmd: "命令取值", raw: "明文密钥", none: "未设置" };
const KEY_KIND_TONE: Record<KeyKind, string> = {
  env: "text-[var(--accent)]",
  cmd: "text-[var(--accent)]",
  raw: "text-[var(--fg-4)]",
  none: "text-[var(--warn)]",
};

const API_MAIN_VALUES: readonly string[] = API_MAIN.map((o) => o.value);
const API_MORE_VALUES: readonly string[] = API_MORE;

const FIELD_ROW = "grid grid-cols-[32px_minmax(0,1fr)] items-center gap-x-2 gap-y-1";


export function ProviderPane({
  adding,
  onAddingChange,
  onOpenModel,
  onJsonError,
}: {
  adding: boolean;
  onAddingChange: (open: boolean) => void;
  /** 选中模型之后调用: 两栏布局下据此切到编辑器视图 */
  onOpenModel: () => void;
  onJsonError: (key: string, msg: string | null) => void;
}) {
  const doc = useModelsConfigStore((s) => s.doc);
  const docBase = useModelsConfigStore((s) => s.docBase);
  const pid = useModelsConfigStore((s) => s.selectedProvider);
  const selectedModelId = useModelsConfigStore((s) => s.selectedModelId);
  const defaults = useModelsConfigStore((s) => s.defaults);
  const probes = useModelsConfigStore((s) => s.probes);
  const selectModel = useModelsConfigStore((s) => s.selectModel);
  const setProviderField = useModelsConfigStore((s) => s.setProviderField);
  const setProviderJson = useModelsConfigStore((s) => s.setProviderJson);
  const renameProvider = useModelsConfigStore((s) => s.renameProvider);
  const deleteProvider = useModelsConfigStore((s) => s.deleteProvider);
  const duplicateProvider = useModelsConfigStore((s) => s.duplicateProvider);
  const deleteModelAt = useModelsConfigStore((s) => s.deleteModelAt);
  const probe = useModelsConfigStore((s) => s.probe);

  const [connOpen, setConnOpen] = useState(true);
  const [advOpen, setAdvOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [pidDraft, setPidDraft] = useState(pid ?? "");
  const [pidErr, setPidErr] = useState<string | null>(null);
  const idInputRef = useRef<HTMLInputElement>(null);
  const focusIdNext = useRef(false);

  // 换供应商: 草稿回到新 id, 敏感信息重新遮蔽, 高级区收起 (与原型一致)
  useEffect(() => {
    setPidDraft(pid ?? "");
    setPidErr(null);
    setShowKey(false);
    setAdvOpen(false);
    if (focusIdNext.current) {
      focusIdNext.current = false;
      setConnOpen(true);
      requestAnimationFrame(() => {
        idInputRef.current?.focus();
        idInputRef.current?.select();
      });
    }
  }, [pid]);

  if (!pid || !doc) {
    return (
      <section className="grid min-h-0 min-w-0 place-content-center justify-items-center gap-3 border-r border-[var(--line)] p-6 text-label text-[var(--fg-3)]">
        在左边选一个供应商
      </section>
    );
  }

  const raw = providersOf(doc)[pid];
  const provider = providerOf(doc, pid);
  const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
  const apiKey = typeof provider.apiKey === "string" ? provider.apiKey : "";
  const apiVal = typeof provider.api === "string" ? provider.api : "";
  const kind = keyKindOf(apiKey);
  const host = hostOf(baseUrl);
  const urlBad = !!baseUrl.trim() && !host;
  const urlWarn = urlBad
    ? "不是合法的 URL"
    : /\/(chat\/completions|responses|messages)\/?$/.test(baseUrl.trim())
      ? "地址一般到 /v1 为止, 接口路径由 pi 自己拼接"
      : null;
  const apiInMain = API_MAIN_VALUES.includes(apiVal);
  const rawModels = rawModelsOf(doc, pid);
  const objModels = rawModels.filter(
    (m): m is JsonObject => isObj(m) && typeof m.id === "string" && m.id !== "",
  );
  const probeState = probes[pid];

  const commitPid = () => {
    const next = pidDraft.trim();
    if (next === pid) return;
    if (!next) {
      setPidErr("ID 不能为空");
      setPidDraft(pid);
      return;
    }
    if (!renameProvider(pid, next)) {
      setPidErr(`「${next}」已经存在`);
      setPidDraft(pid);
      return;
    }
    setPidErr(null);
  };

  const openModel = (mid: string) => {
    selectModel(mid);
    // JSON 模式有错误时切换会被拒, 这时不能切到编辑器视图
    if (useModelsConfigStore.getState().selectedModelId === mid) onOpenModel();
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--line)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] py-3 pl-4 pr-3">
        <span className="min-w-0 flex-1 truncate text-title font-semibold text-[var(--fg)]" title={pid}>
          {pid}
        </span>
        <IconButton
          title="复制这个供应商"
          onClick={() => {
            focusIdNext.current = true;
            if (!duplicateProvider(pid)) focusIdNext.current = false;
          }}
        >
          <Copy className="h-4 w-4" />
        </IconButton>
        <IconButton title="删除这个供应商 (保存前可撤销)" danger onClick={() => deleteProvider(pid)}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!isObj(raw) && (
          <p className="flex items-start gap-2 border-b border-[var(--line)] px-4 py-3 text-mini text-[var(--err)]">
            <CircleAlert className="mt-[2px] h-3 w-3 shrink-0" />
            这个供应商的配置不是对象, pi 无法加载。删除后重新新增, 或在外部编辑器里修正。
          </p>
        )}

        {/* 连接 */}
        {/* 连接: 默认展开, 但要给模型列表留出首屏 —— 标签放左列、密钥类型标进输入框、
            「其他…」挪到标签行, 展开态比上下排版矮约 120px (1200×800 下仍能看到前几行模型) */}
        <div className="flex flex-col gap-2 border-b border-[var(--line)] px-4 pb-4 pt-3">
          <div className="flex items-center justify-between text-label text-[var(--fg-3)]">
            <span>连接</span>
            <button className={LINK} onClick={() => setConnOpen((v) => !v)}>
              {connOpen ? "收起" : "编辑"}
            </button>
          </div>

          {connOpen ? (
            <>
              <div className={FIELD_ROW}>
                <span className="text-label text-[var(--fg-3)]">ID</span>
                <Input
                  ref={idInputRef}
                  className="font-mono"
                  value={pidDraft}
                  onChange={(e) => {
                    setPidDraft(e.target.value);
                    setPidErr(null);
                  }}
                  onBlur={commitPid}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
                  }}
                />
                {pidErr && (
                  <span className="col-start-2">
                    <FieldError>{pidErr}</FieldError>
                  </span>
                )}
              </div>
              <div className={FIELD_ROW}>
                <span className="text-label text-[var(--fg-3)]" title="baseUrl">
                  地址
                </span>
                <Input
                  title="baseUrl"
                  className={`font-mono ${urlBad ? "!border-[var(--err)]" : ""}`}
                  value={baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => setProviderField(pid, "baseUrl", e.target.value)}
                />
                {urlWarn && (
                  <span className="col-start-2 flex items-start gap-2 text-mini text-[var(--warn)]">
                    <TriangleAlert className="mt-[2px] h-3 w-3 shrink-0" />
                    {urlWarn}
                  </span>
                )}
              </div>
              <div className={FIELD_ROW}>
                <span className="text-label text-[var(--fg-3)]" title="apiKey">
                  密钥
                </span>
                <div className="relative">
                  <Input
                    title="apiKey"
                    className={`font-mono ${kind === "raw" ? "pr-8" : kind === "none" ? "" : "pr-20"}`}
                    type={kind === "raw" && !showKey ? "password" : "text"}
                    value={apiKey}
                    placeholder="sk-…、$ENV_VAR 或 !command"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setProviderField(pid, "apiKey", e.target.value)}
                  />
                  {kind === "raw" ? (
                    <button
                      onClick={() => setShowKey((v) => !v)}
                      title={showKey ? "隐藏明文密钥" : "显示明文密钥"}
                      className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-sm text-[var(--fg-3)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
                    >
                      {showKey ? <EyeOff className="h-[14px] w-[14px]" /> : <Eye className="h-[14px] w-[14px]" />}
                    </button>
                  ) : (
                    kind !== "none" && (
                      <span
                        className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-mini ${KEY_KIND_TONE[kind]}`}
                      >
                        {KEY_KIND_TEXT[kind]}
                      </span>
                    )
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="flex min-w-0 items-center gap-2 text-label text-[var(--fg-3)]">
                  <span className="shrink-0">接口类型</span>
                  <span className="truncate font-mono text-mini text-[var(--fg-4)]">{apiVal || "未设置"}</span>
                  <Select
                    density="sm"
                    title="其他接口类型"
                    className="ml-auto max-w-[140px]"
                    value={apiInMain ? "" : apiVal}
                    onChange={(e) => {
                      if (e.target.value) setProviderField(pid, "api", e.target.value);
                    }}
                  >
                    <option value="">其他…</option>
                    {API_MORE.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                    {/* 手写的非法取值也要能看见 (后端保存时会拒), 不能被下拉静默吞成「其他…」 */}
                    {apiVal && !apiInMain && !API_MORE_VALUES.includes(apiVal) && (
                      <option value={apiVal}>{apiVal} (非法)</option>
                    )}
                  </Select>
                </span>
                <Segmented
                  value={apiInMain ? apiVal : null}
                  options={API_MAIN}
                  onChange={(v) => setProviderField(pid, "api", v)}
                  className="self-start"
                />
              </div>
            </>
          ) : (
            <div className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-md bg-[var(--well)] px-3 py-2 text-label shadow-[inset_0_0_0_1px_var(--line)]">
              <span className="text-mini text-[var(--fg-4)]">地址</span>
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={`truncate font-mono ${urlBad ? "text-[var(--err)]" : "text-[var(--fg-2)]"}`}
                  title={baseUrl}
                >
                  {baseUrl.replace(/^https?:\/\//, "") || "未设置"}
                </span>
                {urlWarn && (
                  <span title={urlWarn}>
                    <TriangleAlert className="h-3 w-3 shrink-0 text-[var(--warn)]" />
                  </span>
                )}
              </span>
              <span className="text-mini text-[var(--fg-4)]">密钥</span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[var(--fg-2)]">
                  {kind === "raw" ? "••••••••••••" : apiKey || "未设置"}
                </span>
                <span className={`ml-auto shrink-0 text-mini ${KEY_KIND_TONE[kind]}`}>
                  {kind === "none" ? "" : KEY_KIND_TEXT[kind]}
                </span>
              </span>
              <span className="text-mini text-[var(--fg-4)]">接口</span>
              <span className="truncate text-[var(--fg-2)]" title={apiVal}>
                {API_MAIN.find((o) => o.value === apiVal)?.label ?? (apiVal || "未设置")}
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={probeState?.status === "running"} onClick={() => void probe(pid)}>
              {probeState?.status === "running" ? (
                <LoaderCircle className="h-[14px] w-[14px] animate-spin" />
              ) : (
                <Plug className="h-[14px] w-[14px]" />
              )}
              测试连接
            </Button>
            <Button size="sm" onClick={() => setFetching(true)}>
              <Download className="h-[14px] w-[14px]" />
              拉取模型列表
            </Button>
          </div>
          {probeState && (
            <TestLine state={probeState} have={objModels.map((m) => m.id as string)} onPick={() => setFetching(true)} />
          )}
        </div>

        {/* 模型 */}
        <div className="flex flex-col gap-3 border-b border-[var(--line)] px-4 pb-4 pt-3">
          <div className="flex items-center justify-between text-label text-[var(--fg-3)]">
            <span>
              模型<span className="ml-1 font-mono text-[var(--fg-4)]">{objModels.length}</span>
            </span>
            <button
              onClick={() => onAddingChange(true)}
              className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-label text-[var(--fg-3)] transition-colors duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
            >
              <Plus className="h-[14px] w-[14px]" />
              新增
            </button>
          </div>
          {adding && <AddModelBox pid={pid} onClose={() => onAddingChange(false)} onFetch={() => setFetching(true)} onAdded={onOpenModel} />}
          <div className="-mx-2 flex flex-col gap-[2px]">
            {rawModels.map((m, i) => {
              if (!isObj(m) || typeof m.id !== "string" || m.id === "") {
                return <InvalidModelRow key={`bad-${i}`} value={m} onDelete={() => deleteModelAt(pid, i)} />;
              }
              const mid = m.id;
              const on = mid === selectedModelId;
              const img = Array.isArray(m.input) && m.input.includes("image");
              return (
                <button
                  key={`${mid}#${i}`}
                  onClick={() => openModel(mid)}
                  className={`flex flex-col gap-[2px] rounded-md p-2 text-left transition-colors duration-fast ease-out ${
                    on
                      ? "bg-[var(--accent-soft)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--accent)_45%,transparent)]"
                      : "hover:bg-[var(--hover)]"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`truncate font-mono text-label text-[var(--fg)] ${on ? "font-semibold" : ""}`}>
                      {mid}
                    </span>
                    {defaults?.provider === pid && defaults.model === mid && (
                      <Star className="h-3 w-3 shrink-0 text-[var(--accent)]" aria-label="新会话默认" />
                    )}
                    {isModelChanged(docBase, pid, m) && (
                      <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--warn)]" title="有未保存的改动" />
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-mini text-[var(--fg-4)]">
                    <span className="truncate">{typeof m.name === "string" && m.name ? m.name : "未命名"}</span>
                    <span className="flex-1" />
                    {m.reasoning === true && (
                      <span title="推理">
                        <Brain className="h-3 w-3" />
                      </span>
                    )}
                    {img && (
                      <span title="图像输入">
                        <Image className="h-3 w-3" />
                      </span>
                    )}
                    <span className="min-w-[32px] text-right font-mono">{formatTokenShort(m.contextWindow) || "—"}</span>
                  </span>
                </button>
              );
            })}
            {rawModels.length === 0 && !adding && (
              <p className="px-3 py-6 text-center text-label text-[var(--fg-4)]">还没有模型。拉取远端列表最快。</p>
            )}
          </div>
        </div>

        {/* 高级 */}
        <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
          <button
            onClick={() => setAdvOpen((v) => !v)}
            className="flex items-center gap-2 text-left text-label text-[var(--fg-3)] transition-colors duration-fast ease-out hover:text-[var(--fg)]"
          >
            {advOpen ? <ChevronDown className="h-[14px] w-[14px]" /> : <ChevronRight className="h-[14px] w-[14px]" />}
            高级
            <span className="truncate text-mini text-[var(--fg-4)]">鉴权头 · 请求头 · 供应商级兼容 · 内置模型覆盖</span>
          </button>
          {advOpen && (
            <>
              <AuthHeaderToggle
                value={provider.authHeader}
                onChange={(v) => setProviderField(pid, "authHeader", v)}
              />
              {(
                [
                  ["headers", "请求头", "每次请求都带上的额外 header; 值同样支持 $ENV_VAR"],
                  ["compat", "供应商级兼容", "模型级同名开关会覆盖这里"],
                  ["modelOverrides", "内置模型覆盖", "只改 pi 内置模型的个别字段, 未知 id 会被忽略"],
                ] as const
              ).map(([k, label, hint]) => (
                <JsonField
                  key={`${pid}|${k}`}
                  fieldKey={`${pid}|${k}`}
                  label={label}
                  jsonKey={k}
                  hint={hint}
                  value={provider[k]}
                  onError={onJsonError}
                  onCommit={(text) => setProviderJson(pid, k, text)}
                />
              ))}
            </>
          )}
        </div>
      </div>
      {fetching && <FetchModelsDialog pid={pid} onClose={() => setFetching(false)} />}
    </section>
  );
}



/** 测试结果行: 只在本次打开面板期间显示, 测的是编辑中的连接信息 */
function TestLine({ state, have, onPick }: { state: ProbeState; have: string[]; onPick: () => void }) {
  const urlLine = (suffix = "") => (
    <span className="mt-1 block break-all font-mono text-mini text-[var(--fg-4)]">
      GET {state.status === "running" ? state.url : state.result.url}
      {suffix}
    </span>
  );
  if (state.status === "running") {
    return (
      <div className="flex items-start gap-2 rounded-md bg-[var(--well)] px-3 py-2 text-label text-[var(--fg-3)]">
        <LoaderCircle className="mt-[2px] h-4 w-4 shrink-0 animate-spin" />
        <span className="min-w-0">
          正在请求
          {urlLine()}
        </span>
      </div>
    );
  }
  const r = state.result;
  if (!r.ok) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-[var(--well)] px-3 py-2 text-label leading-relaxed text-[var(--fg-2)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--err)_40%,transparent)]">
        <CircleAlert className="mt-[2px] h-4 w-4 shrink-0 text-[var(--err)]" />
        <span className="min-w-0">
          <span className="block break-all font-semibold text-[var(--fg)]">{r.message ?? "连接失败"}</span>
          {probeHint(r)}
          {r.url && urlLine(r.status !== null ? ` · ${r.status}` : "")}
        </span>
      </div>
    );
  }
  const haveSet = new Set(have);
  const fresh = r.models.filter((id) => !haveSet.has(id)).length;
  // 成功时请求地址收进悬停提示: 这一行常驻在模型列表上方, 多一行 URL 就少露一行模型
  return (
    <div
      title={`GET ${r.url} · ${r.status}`}
      className="flex items-start gap-2 rounded-md bg-[var(--well)] px-3 py-2 text-label leading-relaxed text-[var(--fg-2)]"
    >
      <CircleCheck className="mt-[2px] h-4 w-4 shrink-0 text-[var(--ok)]" />
      <span className="min-w-0">
        连接正常 · <span className="font-mono tabular-nums">{r.elapsed_ms} ms</span> · 远端 {r.models.length} 个模型
        <br />
        {fresh ? (
          <button className={LINK} onClick={onPick}>
            其中 {fresh} 个还没添加, 去挑选
          </button>
        ) : (
          <span className="text-[var(--fg-3)]">远端模型都已添加</span>
        )}
        {r.message && <span className="block text-mini text-[var(--warn)]">{r.message}</span>}
      </span>
    </div>
  );
}

/**
 * 新增模型输入框: 输入 id 时列出其他供应商里的同名定义 (一键沿用参数), 回车新建空白模型;
 * 输入为空时推荐「其他供应商常用、这里还没有」的模型。
 */
function AddModelBox({
  pid,
  onClose,
  onFetch,
  onAdded,
}: {
  pid: string;
  onClose: () => void;
  onFetch: () => void;
  onAdded: () => void;
}) {
  const doc = useModelsConfigStore((s) => s.doc);
  const addModels = useModelsConfigStore((s) => s.addModels);
  const notify = useModelsConfigStore((s) => s.notify);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, onClose);
  // 连接区默认展开, 输入框常落在中栏首屏以下; autoFocus 只把输入框本身滚进来,
  // 下面的建议列表仍在视口外 —— 整个框一起滚进来
  useEffect(() => {
    boxRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const have = useMemo(() => new Set(modelsOf(doc, pid).map((m) => m.id)), [doc, pid]);
  const query = q.trim();
  const suggestions = useMemo(() => {
    const out: { pid: string; model: JsonObject }[] = [];
    if (query) {
      const ql = query.toLowerCase();
      for (const o of providerIds(doc)) {
        if (o === pid) continue;
        for (const m of modelsOf(doc, o)) {
          if (typeof m.id === "string" && m.id.toLowerCase().includes(ql)) out.push({ pid: o, model: m });
        }
      }
      return out.slice(0, 6);
    }
    const count = new Map<string, number>();
    for (const o of providerIds(doc)) {
      if (o === pid) continue;
      for (const m of modelsOf(doc, o)) {
        if (typeof m.id === "string" && !have.has(m.id)) count.set(m.id, (count.get(m.id) ?? 0) + 1);
      }
    }
    return [...count]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .flatMap(([id]) => {
        const src = findModelSource(doc, id, pid);
        return src ? [src] : [];
      });
  }, [doc, pid, query, have]);

  const exists = !!query && have.has(query);
  const addBlank = () => {
    if (!query || exists) return;
    addModels(pid, [{ id: query, input: ["text"] }]);
    onClose();
    onAdded();
    notify("已新建空白模型, 记得补上下文窗口和最大输出");
  };
  const addFrom = (src: { pid: string; model: JsonObject }) => {
    const base = src.model.id as string;
    let id = base;
    for (let i = 2; have.has(id); i++) id = `${base}-${i}`;
    addModels(pid, [{ ...structuredClone(src.model), id }]);
    onClose();
    onAdded();
    notify(`已沿用 ${src.pid} 里 ${base} 的参数`);
  };

  const cost = (m: JsonObject) =>
    isObj(m.cost) && typeof m.cost.input === "number" && typeof m.cost.output === "number"
      ? ` · $${m.cost.input}/$${m.cost.output}`
      : "";

  return (
    <div
      ref={boxRef}
      className="-mx-2 flex scroll-my-3 flex-col gap-1 rounded-md bg-[var(--well)] p-2 shadow-[inset_0_0_0_1px_var(--line)]"
    >
      <Input
        autoFocus
        className="font-mono"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            addBlank();
          }
        }}
        placeholder="输入模型 id, 比如 deepseek-v4-pro"
      />
      {query && (
        <button
          disabled={exists}
          onClick={addBlank}
          className="flex w-full min-w-0 items-center gap-2 rounded-[6px] px-2 py-1 text-left text-label hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
        >
          <Plus className="h-[14px] w-[14px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {exists ? (
              `「${query}」已经在这个供应商里`
            ) : (
              <>
                新建空白模型 <span className="font-mono font-semibold">{query}</span>
              </>
            )}
          </span>
          {!exists && (
            <span className="rounded-sm border border-[var(--line-2)] px-1 font-mono text-micro text-[var(--fg-4)]">
              Enter
            </span>
          )}
        </button>
      )}
      {suggestions.length > 0 && (
        <div className="px-2 pt-1 text-mini text-[var(--fg-4)]">
          {query ? "沿用其他供应商里的同名定义" : "其他供应商常用、这里还没有的"}
        </div>
      )}
      {suggestions.map((s) => (
        <button
          key={`${s.pid}|${String(s.model.id)}`}
          onClick={() => addFrom(s)}
          className="flex w-full min-w-0 items-center gap-2 rounded-[6px] px-2 py-1 text-left text-label hover:bg-[var(--hover)]"
        >
          <Copy className="h-[14px] w-[14px] shrink-0 text-[var(--fg-4)]" />
          <span className="truncate font-mono">{String(s.model.id)}</span>
          <span className="min-w-0 flex-1 truncate text-mini text-[var(--fg-3)]">
            {s.pid} · {formatTokenShort(s.model.contextWindow) || "—"}
            {s.model.reasoning === true ? " · 推理" : ""}
            {cost(s.model)}
          </span>
        </button>
      ))}
      <div className="flex justify-between px-2 pt-1">
        <button className={LINK} onClick={onFetch}>
          从供应商拉取列表
        </button>
        <button className={LINK} onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}

/** models[] 里的非对象 / 无 id 项: 照旧显示并可删除 (保真: 不静默丢弃用户数据) */
function InvalidModelRow({ value, onDelete }: { value: unknown; onDelete: () => void }) {
  let preview: string;
  try {
    preview = JSON.stringify(value) ?? String(value);
  } catch {
    preview = String(value);
  }
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md p-2 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--err)_40%,transparent)]">
      <Badge tone="err">非法项</Badge>
      <span className="min-w-0 flex-1 truncate font-mono text-mini text-[var(--fg-3)]" title={preview}>
        {preview}
      </span>
      <IconButton title="删除这一项 (保存前可撤销)" danger onClick={onDelete}>
        <Trash2 className="h-[14px] w-[14px]" />
      </IconButton>
    </div>
  );
}

/**
 * authHeader 开关。pi schema 里它是布尔 (开 = 额外发送 Authorization: Bearer <key>);
 * 旧版面板把它当字符串输入框, 写过字就会让 pi 加载 models.json 失败 —— 非布尔值标出并可一键清除。
 */
function AuthHeaderToggle({ value, onChange }: { value: unknown; onChange: (v: true | null) => void }) {
  const bad = value !== undefined && typeof value !== "boolean";
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-label text-[var(--fg-3)]">
        鉴权头<span className="font-mono text-mini text-[var(--fg-4)]">authHeader</span>
      </span>
      {bad ? (
        <div className="flex flex-wrap items-center gap-2 text-mini">
          <Badge tone="err">值异常</Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-[var(--fg-3)]" title={JSON.stringify(value)}>
            {JSON.stringify(value)}
          </span>
          <Button size="sm" variant="danger" onClick={() => onChange(null)}>
            清除
          </Button>
        </div>
      ) : (
        <label className="flex cursor-pointer items-center gap-2 text-label text-[var(--fg-2)]">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked ? true : null)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          额外发送 <span className="font-mono">Authorization: Bearer</span> 头
        </label>
      )}
      <span className="text-mini text-[var(--fg-4)]">
        {bad ? "pi 只接受 true / 不写; 这个值会让 pi 加载 models.json 失败, 保存也会被拒绝" : "OpenAI 兼容接口默认就会带这个头, 一般不用开"}
      </span>
    </div>
  );
}

/**
 * 高级区的 JSON 字段: 草稿 + 失焦提交, 非法 JSON 标红并占住错误槽位 (槽位非空时禁用保存)。
 * 外部值真的变了 (撤销 / 重新加载) 且输入框没在编辑时才重灌草稿 —— 按内容比较, 所以别的字段
 * 的编辑换掉 doc 对象不会冲掉这里的半截输入。
 */
function JsonField({
  label,
  jsonKey,
  hint,
  value,
  fieldKey,
  onError,
  onCommit,
}: {
  label: string;
  jsonKey: string;
  hint: string;
  value: unknown;
  fieldKey: string;
  onError: (key: string, msg: string | null) => void;
  onCommit: (text: string) => string | null;
}) {
  const serialized = value === undefined || value === null ? "" : JSON.stringify(value, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const last = useRef(serialized);

  useEffect(() => {
    if (serialized !== last.current && !focused.current) {
      setText(serialized);
      setError(null);
      onError(fieldKey, null);
    }
    last.current = serialized;
  }, [serialized, fieldKey, onError]);

  useEffect(() => () => onError(fieldKey, null), [fieldKey, onError]);

  const commit = () => {
    focused.current = false;
    const err = onCommit(text);
    setError(err);
    onError(fieldKey, err);
  };

  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-label text-[var(--fg-3)]">
        {label}
        <span className="font-mono text-mini text-[var(--fg-4)]">{jsonKey}</span>
      </span>
      <textarea
        value={text}
        rows={3}
        spellCheck={false}
        placeholder="{}"
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => {
          setText(e.target.value);
          // 已经改对了就立刻撤掉红框, 不必等失焦 (否则点「保存」第一下只触发 blur)
          if (error) {
            try {
              if (e.target.value.trim()) JSON.parse(e.target.value);
              setError(null);
              onError(fieldKey, null);
            } catch {
              /* 仍非法, 保持错误态 */
            }
          }
        }}
        onBlur={commit}
        className={`w-full resize-y rounded-md border bg-[var(--well)] px-2 py-2 font-mono text-label leading-relaxed text-[var(--fg)] outline-none transition-colors duration-fast ease-out placeholder:text-[var(--fg-4)] ${
          error ? "border-[var(--err)]" : "border-[var(--line)] focus:border-[var(--accent)]"
        }`}
      />
      {error ? <FieldError>{error}</FieldError> : <span className="text-mini text-[var(--fg-4)]">{hint}</span>}
    </label>
  );
}
