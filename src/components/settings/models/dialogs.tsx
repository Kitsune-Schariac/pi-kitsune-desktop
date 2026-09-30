// 「模型与供应商」页的三个对话框 (拉取模型 / 复制到 / 新增供应商) 与它们共用的外壳。
// 默认模型选择器也用这个外壳, 但它属于默认条, 放在 DefaultsBar.tsx。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CircleAlert, LoaderCircle, Plug, RefreshCw, Search, X } from "lucide-react";
import {
  findModelSource,
  modelsOf,
  providerIds,
  providerOf,
  useModelsConfigStore,
  type JsonObject,
  type ProbeResult,
} from "../../../store/modelsConfig";
import { Button, Input, Segmented } from "../../ui";
import { API_MAIN, Badge, hostOf, probeHint, useEscapeLayer } from "./shared";

/**
 * 对话框外壳: 遮罩 + 实底卡片 (--popover, 浮层不能用半透明底, 会透出下面的字)。
 * 点遮罩空白处或按 Esc 关闭; body 自己滚动, 头尾固定。
 */
export function DialogShell({
  title,
  subtitle,
  tools,
  footer,
  onClose,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  tools?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEscapeLayer(true, onClose);
  return (
    <div
      data-overlay
      className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="view-in-soft flex max-h-[min(640px,calc(100%-32px))] w-[min(560px,100%)] flex-col rounded-lg border border-[var(--line-2)] bg-[var(--popover)] shadow-[var(--shadow)]"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-[var(--line)] py-3 pl-5 pr-3">
          <div className="min-w-0 flex-1">
            <div className="text-title font-semibold text-[var(--fg)]">{title}</div>
            {subtitle && <div className="mt-1 break-all text-mini text-[var(--fg-4)]">{subtitle}</div>}
          </div>
          <button
            onClick={onClose}
            title="关闭 (Esc)"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--fg-3)] transition-colors duration-fast ease-out hover:bg-[var(--hover)] hover:text-[var(--fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {tools && <div className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-3">{tools}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--line)] py-3 pl-5 pr-4">{footer}</div>
        )}
      </div>
    </div>
  );
}

/** 对话框内的筛选框 (拉取模型 / 默认模型选择器共用形态) */
export function DialogSearch({
  value,
  onChange,
  placeholder,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onEnter?: () => void;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-[var(--fg-4)]" />
      <Input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) onEnter?.();
        }}
        placeholder={placeholder}
        className="pl-7"
      />
    </div>
  );
}

function StateBlock({ children }: { children: ReactNode }) {
  return (
    <div className="grid place-content-center justify-items-center gap-2 px-4 py-12 text-center text-label text-[var(--fg-3)]">
      {children}
    </div>
  );
}

const ROW = "flex min-w-0 items-center gap-3 rounded-md px-2 py-2";

/**
 * 拉取远端模型列表并勾选添加。请求与「测试连接」是同一个命令, 结果也同步刷新到该供应商的
 * 测试状态点。添加时有同名定义的沿用那份参数 (换成当前 id), 没有的只写 id + 文本输入。
 */
export function FetchModelsDialog({ pid, onClose }: { pid: string; onClose: () => void }) {
  const doc = useModelsConfigStore((s) => s.doc);
  const probe = useModelsConfigStore((s) => s.probe);
  const addModels = useModelsConfigStore((s) => s.addModels);
  const notify = useModelsConfigStore((s) => s.notify);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [query, setQuery] = useState("");
  const [onlyNew, setOnlyNew] = useState<"all" | "new">("all");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // 连点「重试」时只认最后一次请求的结果
  const epochRef = useRef(0);

  const run = () => {
    const epoch = ++epochRef.current;
    setResult(null);
    void probe(pid).then((r) => {
      if (epoch === epochRef.current) setResult(r);
    });
  };
  useEffect(() => {
    run();
    return () => {
      epochRef.current++;
    };
    // 只在打开时拉一次; 之后由「重试」触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const have = useMemo(() => new Set(modelsOf(doc, pid).map((m) => m.id)), [doc, pid]);
  const base = String(providerOf(doc, pid).baseUrl ?? "").replace(/\/+$/, "");
  const title = `拉取模型 · ${pid}`;

  if (!result) {
    return (
      <DialogShell title={title} subtitle={<span className="font-mono">GET {base}/models</span>} onClose={onClose}>
        <StateBlock>
          <LoaderCircle className="h-4 w-4 animate-spin text-[var(--accent)]" />
          正在请求远端模型列表…
        </StateBlock>
      </DialogShell>
    );
  }
  if (!result.ok) {
    return (
      <DialogShell
        title={title}
        subtitle={<span className="font-mono">GET {result.url}</span>}
        onClose={onClose}
        footer={
          <>
            <span className="flex-1" />
            <Button size="sm" onClick={onClose}>
              关闭
            </Button>
            <Button size="sm" variant="primary" onClick={run}>
              <RefreshCw className="h-[14px] w-[14px]" />
              重试
            </Button>
          </>
        }
      >
        <StateBlock>
          <CircleAlert className="h-4 w-4 text-[var(--err)]" />
          <span className="break-all font-semibold text-[var(--fg)]">{result.message ?? "请求失败"}</span>
          <span>{probeHint(result)}</span>
        </StateBlock>
      </DialogShell>
    );
  }

  const fresh = result.models.filter((id) => !have.has(id));
  const q = query.trim().toLowerCase();
  const list = result.models.filter((id) => (!q || id.toLowerCase().includes(q)) && (onlyNew === "all" || !have.has(id)));
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const confirm = () => {
    // 按远端列表顺序添加, 与对话框里看到的顺序一致
    const ids = result.models.filter((id) => checked.has(id) && !have.has(id));
    let reused = 0;
    const items: JsonObject[] = ids.map((id) => {
      const src = findModelSource(doc, id, pid);
      if (!src) return { id, input: ["text"] };
      reused++;
      return { ...structuredClone(src.model), id };
    });
    addModels(pid, items);
    onClose();
    notify(`已添加 ${items.length} 个模型, 其中 ${reused} 个沿用了同名定义的参数`);
  };

  return (
    <DialogShell
      title={title}
      subtitle={
        <span className="font-mono">
          GET {result.url} · {result.elapsed_ms} ms · {result.models.length} 个
        </span>
      }
      onClose={onClose}
      tools={
        <>
          <DialogSearch value={query} onChange={setQuery} placeholder="筛选" />
          <Segmented
            size="sm"
            value={onlyNew}
            onChange={setOnlyNew}
            options={[
              { value: "all", label: "全部" },
              { value: "new", label: `未添加 ${fresh.length}` },
            ]}
          />
        </>
      }
      footer={
        <>
          <span className="min-w-0 flex-1 text-mini text-[var(--fg-3)]">
            已选 {checked.size} 个 · 有同名定义的沿用参数, 其余只写 id
          </span>
          <Button size="sm" disabled={!fresh.length} onClick={() => setChecked(new Set(fresh))}>
            全选未添加
          </Button>
          <Button size="sm" variant="primary" disabled={!checked.size} onClick={confirm}>
            添加 {checked.size || ""} 个
          </Button>
        </>
      }
    >
      {list.length === 0 ? (
        <StateBlock>{result.models.length ? "没有匹配的模型" : "远端返回了空列表"}</StateBlock>
      ) : (
        list.map((id) => {
          const added = have.has(id);
          const src = added ? null : findModelSource(doc, id, pid);
          return (
            <label key={id} className={`${ROW} ${added ? "" : "cursor-pointer hover:bg-[var(--hover)]"}`}>
              <input
                type="checkbox"
                checked={added || checked.has(id)}
                disabled={added}
                onChange={() => toggle(id)}
                className="h-4 w-4 shrink-0 accent-[var(--accent)] disabled:opacity-40"
              />
              <span className="min-w-0 flex-1 truncate font-mono text-label text-[var(--fg)]" title={id}>
                {id}
              </span>
              {added ? (
                <Badge>已添加</Badge>
              ) : src ? (
                <span className="truncate text-mini text-[var(--fg-4)]">沿用 {src.pid} 的参数</span>
              ) : (
                <span className="truncate text-mini text-[var(--warn)]">无参考, 需补参数</span>
              )}
            </label>
          );
        })
      )}
    </DialogShell>
  );
}

/** 复制模型到其他供应商: 目标里已有同名的原位覆盖, 没有的追加 */
export function CopyToDialog({ pid, mid, onClose }: { pid: string; mid: string; onClose: () => void }) {
  const doc = useModelsConfigStore((s) => s.doc);
  const copyModelTo = useModelsConfigStore((s) => s.copyModelTo);
  const notify = useModelsConfigStore((s) => s.notify);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const targets = providerIds(doc).filter((o) => o !== pid);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const confirm = () => {
    const picked = targets.filter((t) => checked.has(t));
    copyModelTo(pid, mid, picked);
    onClose();
    notify(`已把 ${mid} 复制到 ${picked.length} 个供应商`);
  };

  return (
    <DialogShell
      title={`复制「${mid}」到…`}
      subtitle="连同上下文、价格、思考映射、兼容开关一起复制"
      onClose={onClose}
      footer={
        <>
          <span className="flex-1 text-mini text-[var(--fg-3)]">已选 {checked.size} 个供应商</span>
          <Button size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" variant="primary" disabled={!checked.size} onClick={confirm}>
            复制
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <StateBlock>没有其他供应商</StateBlock>
      ) : (
        targets.map((o) => {
          const exists = modelsOf(doc, o).some((m) => m.id === mid);
          return (
            <label key={o} className={`${ROW} cursor-pointer hover:bg-[var(--hover)]`}>
              <input
                type="checkbox"
                checked={checked.has(o)}
                onChange={() => toggle(o)}
                className="h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="shrink-0 font-mono text-label text-[var(--fg)]">{o}</span>
              <span className="min-w-0 flex-1 truncate text-mini text-[var(--fg-4)]">
                {hostOf(providerOf(doc, o).baseUrl)}
              </span>
              {exists && <Badge tone="warn">已有同名 · 将覆盖</Badge>}
            </label>
          );
        })
      )}
    </DialogShell>
  );
}

/** 新增供应商: 填好连接信息后创建并立即测一次连接 */
export function NewProviderDialog({ onClose }: { onClose: () => void }) {
  const doc = useModelsConfigStore((s) => s.doc);
  const addProvider = useModelsConfigStore((s) => s.addProvider);
  const probe = useModelsConfigStore((s) => s.probe);
  const [id, setId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [api, setApi] = useState<string>("openai-completions");
  const [err, setErr] = useState<string | null>(null);

  const create = () => {
    const cleanId = id.trim();
    const cleanBase = baseUrl.trim();
    if (!cleanId) return setErr("先起个 ID");
    if (providerIds(doc).includes(cleanId)) return setErr(`「${cleanId}」已经存在`);
    if (!hostOf(cleanBase)) return setErr("地址需要是完整的 URL, 比如 https://api.example.com/v1");
    const init: JsonObject = { baseUrl: cleanBase, api };
    if (apiKey.trim()) init.apiKey = apiKey.trim();
    init.models = [];
    // 当前模型 JSON 有未修正的错误时切不走 (addProvider 会切换选中项)
    if (!addProvider(cleanId, init)) return setErr("当前模型的 JSON 有错误, 先修正或切回表单");
    onClose();
    void probe(cleanId);
  };
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      create();
    }
  };
  const field = (label: ReactNode, input: ReactNode) => (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-label text-[var(--fg-3)]">{label}</span>
      {input}
    </label>
  );

  return (
    <DialogShell
      title="新增供应商"
      subtitle="创建后会自动测一次连接"
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Button size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" variant="primary" onClick={create}>
            <Plug className="h-[14px] w-[14px]" />
            创建并测试
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-2 pb-1 pt-3" onKeyDown={onEnter}>
        {field(
          <>
            ID<span className="text-mini text-[var(--fg-4)]">在模型选择器里显示</span>
          </>,
          <Input
            autoFocus
            className="font-mono"
            value={id}
            placeholder="my-relay"
            onChange={(e) => {
              setId(e.target.value);
              setErr(null);
            }}
          />,
        )}
        {field(
          <>
            地址<span className="font-mono text-mini text-[var(--fg-4)]">baseUrl</span>
          </>,
          <Input
            className="font-mono"
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setErr(null);
            }}
          />,
        )}
        {field(
          <>
            密钥<span className="text-mini text-[var(--fg-4)]">推荐写成 $ENV_VAR, 明文会存在 models.json 里</span>
          </>,
          <Input
            className="font-mono"
            value={apiKey}
            placeholder="$MY_RELAY_API_KEY"
            autoComplete="off"
            onChange={(e) => {
              setApiKey(e.target.value);
              setErr(null);
            }}
          />,
        )}
        <div className="flex flex-col gap-1">
          <span className="text-label text-[var(--fg-3)]">接口类型</span>
          <div>
            <Segmented value={api} onChange={setApi} options={API_MAIN} />
          </div>
        </div>
        {err && (
          <span className="inline-flex items-center gap-2 text-mini text-[var(--err)]">
            <CircleAlert className="h-3 w-3" />
            {err}
          </span>
        )}
      </div>
    </DialogShell>
  );
}
