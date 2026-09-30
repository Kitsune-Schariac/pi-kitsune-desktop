// 第一栏: 供应商列表 + 搜索 + 新增入口。
import { useMemo, useState } from "react";
import { LoaderCircle, Plus, Search, Star, X } from "lucide-react";
import {
  changedProviderIds,
  providerOf,
  providersOf,
  rawModelsOf,
  modelsOf,
  useModelsConfigStore,
} from "../../../store/modelsConfig";
import { Input } from "../../ui";
import { NewProviderDialog } from "./dialogs";
import { hostOf } from "./shared";

export function ProviderList() {
  const doc = useModelsConfigStore((s) => s.doc);
  const docBase = useModelsConfigStore((s) => s.docBase);
  const defaults = useModelsConfigStore((s) => s.defaults);
  const probes = useModelsConfigStore((s) => s.probes);
  const selected = useModelsConfigStore((s) => s.selectedProvider);
  const selectProvider = useModelsConfigStore((s) => s.selectProvider);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const changed = useMemo(() => changedProviderIds(doc, docBase), [doc, docBase]);
  const ids = Object.keys(providersOf(doc));
  const q = query.trim().toLowerCase();

  // 搜索同时匹配 id / 域名 / 模型 id / 模型显示名; 只因模型命中时行内点出是哪个模型
  const rows = ids.flatMap((id) => {
    const host = hostOf(providerOf(doc, id).baseUrl);
    if (!q) return [{ id, host, hit: null as string | null }];
    if (id.toLowerCase().includes(q) || host.toLowerCase().includes(q)) return [{ id, host, hit: null }];
    const m = modelsOf(doc, id).find(
      (x) => String(x.id ?? "").toLowerCase().includes(q) || String(x.name ?? "").toLowerCase().includes(q),
    );
    return m ? [{ id, host, hit: String(m.id) }] : [];
  });

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--line)] bg-[var(--pane)]">
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-3">
        <div className="text-label text-[var(--fg-3)]">
          供应商<span className="ml-1 font-mono text-[var(--fg-4)]">{ids.length}</span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-[var(--fg-4)]" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="供应商、域名或模型 id"
            className="pl-7 pr-7"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title="清空"
              className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-sm text-[var(--fg-4)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
            >
              <X className="h-[14px] w-[14px]" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {ids.length === 0 ? (
          <p className="px-3 py-6 text-center text-label text-[var(--fg-4)]">还没有供应商, 点下方新增</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-label text-[var(--fg-4)]">
            没有匹配「{query.trim()}」的供应商或模型
          </p>
        ) : (
          <div className="flex flex-col gap-[2px]">
            {rows.map(({ id, host, hit }) => {
              const on = id === selected;
              const probe = probes[id];
              return (
                <button
                  key={id}
                  onClick={() => selectProvider(id)}
                  title={id}
                  className={`relative flex w-full flex-col gap-[2px] rounded-md py-2 pl-3 pr-3 text-left transition-colors duration-fast ease-out ${
                    on ? "bg-[var(--raise)] shadow-[inset_0_0_0_1px_var(--line)]" : "hover:bg-[var(--hover)]"
                  }`}
                >
                  {on && <span className="absolute bottom-3 left-0 top-3 w-[2px] rounded-r-sm bg-[var(--accent)]" />}
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`truncate text-body ${on ? "font-semibold text-[var(--fg)]" : "text-[var(--fg-2)]"}`}
                    >
                      {id}
                    </span>
                    {defaults?.provider === id && (
                      <Star className="h-3 w-3 shrink-0 text-[var(--accent)]" aria-label="新会话默认所在供应商" />
                    )}
                    {changed.has(id) && (
                      <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--warn)]" title="有未保存的改动" />
                    )}
                    <span className="flex-1" />
                    {probe?.status === "running" && (
                      <LoaderCircle className="h-3 w-3 shrink-0 animate-spin text-[var(--fg-4)]" />
                    )}
                    {probe?.status === "done" && (
                      <span
                        className={`h-[6px] w-[6px] shrink-0 rounded-full ${
                          probe.result.ok ? "bg-[var(--ok)]" : "bg-[var(--err)]"
                        }`}
                        title={probe.result.ok ? "连接正常" : probe.result.message ?? "连接失败"}
                      />
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-mini text-[var(--fg-4)]">{host || "未设置地址"}</span>
                    <span className="flex-1" />
                    <span className="shrink-0 font-mono text-mini text-[var(--fg-4)]">{rawModelsOf(doc, id).length}</span>
                  </span>
                  {hit && <span className="truncate text-mini text-[var(--accent)]">含 {hit}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--line)] p-2">
        <button
          onClick={() => setCreating(true)}
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-dashed border-[var(--line-2)] text-label text-[var(--fg-3)] transition-colors duration-fast ease-out hover:border-[var(--accent)] hover:text-[var(--fg)]"
        >
          <Plus className="h-[14px] w-[14px]" />
          新增供应商
        </button>
      </div>
      {creating && <NewProviderDialog onClose={() => setCreating(false)} />}
    </section>
  );
}
