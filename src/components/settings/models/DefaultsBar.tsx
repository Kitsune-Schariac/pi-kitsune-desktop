// 「新会话默认」条: settings.json 的 defaultProvider / defaultModel / defaultThinkingLevel。
// 桌面端新建会话不传 --provider / --model, 所以这三个键就是新会话实际用的值。
import { useMemo, useState } from "react";
import { ChevronDown, Dot, Star } from "lucide-react";
import {
  THINKING_LEVELS,
  modelOf,
  modelsOf,
  providerIds,
  providerOf,
  providersOf,
  useModelsConfigStore,
} from "../../../store/modelsConfig";
import { formatTokenShort } from "../../../lib/tokenCount";
import { Segmented } from "../../ui";
import { DialogSearch, DialogShell } from "./dialogs";
import { Badge, hostOf } from "./shared";

const LEVEL_OPTIONS = THINKING_LEVELS.map((l) => ({ value: l as string, label: l }));

export function DefaultsBar() {
  const doc = useModelsConfigStore((s) => s.doc);
  const docBase = useModelsConfigStore((s) => s.docBase);
  const defaults = useModelsConfigStore((s) => s.defaults);
  const settingsPath = useModelsConfigStore((s) => s.settingsPath);
  const settingsParseError = useModelsConfigStore((s) => s.settingsParseError);
  const setDefaults = useModelsConfigStore((s) => s.setDefaults);
  const [picking, setPicking] = useState(false);

  const readOnly = !defaults || !!settingsParseError;
  const provider = defaults?.provider ?? "";
  const model = defaults?.model ?? "";
  // 默认模型的三种不存在: provider 在 models.json 但模型没了 / provider 本次被删 → 已不存在;
  // provider 从来不在 models.json → 多半是 pi 内置供应商 (anthropic 等), 不能当错误报
  let missing: "gone" | "external" | null = null;
  if (provider && model && !modelOf(doc, provider, model)) {
    const inDoc = provider in providersOf(doc);
    const inBase = provider in providersOf(docBase);
    missing = inDoc || inBase ? "gone" : "external";
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-[var(--line)] bg-[var(--pane)] py-2 pl-6 pr-4">
      <div className="flex min-w-0 flex-[1_1_320px] items-center gap-3">
        <span className="whitespace-nowrap text-label text-[var(--fg-3)]">新会话默认</span>
        <button
          disabled={readOnly}
          onClick={() => setPicking(true)}
          title={readOnly ? "settings.json 不可用, 默认值只读" : "选择新会话默认模型"}
          className={`flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md border bg-[var(--well)] px-3 transition-colors duration-fast ease-out hover:border-[var(--line-2)] disabled:cursor-not-allowed disabled:opacity-60 ${
            missing === "gone" ? "border-[var(--err)]" : "border-[var(--line)]"
          }`}
        >
          <Star className="h-[14px] w-[14px] shrink-0 text-[var(--accent)]" />
          {provider || model ? (
            <span className="flex min-w-0 items-center gap-1 font-mono text-label">
              <span className="truncate text-[var(--fg-3)]">{provider || "-"}</span>
              <span className="text-[var(--fg-4)]">/</span>
              <span className="truncate font-semibold text-[var(--fg)]">{model || "-"}</span>
            </span>
          ) : (
            <span className="text-label text-[var(--fg-4)]">未设置</span>
          )}
          {missing === "gone" && <Badge tone="err">已不存在</Badge>}
          {missing === "external" && (
            <Badge tone="warn" title="可能是 pi 内置供应商; 这里只能选 models.json 里的模型">
              不在 models.json
            </Badge>
          )}
          <ChevronDown className="h-[14px] w-[14px] shrink-0 text-[var(--fg-4)]" />
        </button>
      </div>
      <div className="flex max-w-full items-center gap-3 overflow-x-auto">
        <span className="whitespace-nowrap text-label text-[var(--fg-3)]">默认思考</span>
        <Segmented
          size="sm"
          accent
          disabled={readOnly}
          value={defaults?.thinking || null}
          onChange={(v) => setDefaults({ thinking: v })}
          options={LEVEL_OPTIONS}
          ariaLabel="新会话默认思考档位"
        />
      </div>
      {settingsParseError ? (
        <Badge tone="err" title={settingsParseError} className="ml-auto">
          settings.json 不可用
        </Badge>
      ) : (
        <span className="ml-auto font-mono text-mini text-[var(--fg-4)]" title={settingsPath}>
          settings.json
        </span>
      )}
      {picking && (
        <DefaultModelDialog
          onPick={(pid, mid) => {
            setDefaults({ provider: pid, model: mid });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** 可搜索、按供应商分组的默认模型选择器; 回车选中第一个匹配项 */
function DefaultModelDialog({
  onPick,
  onClose,
}: {
  onPick: (pid: string, mid: string) => void;
  onClose: () => void;
}) {
  const doc = useModelsConfigStore((s) => s.doc);
  const defaults = useModelsConfigStore((s) => s.defaults);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providerIds(doc)
      .map((pid) => ({
        pid,
        models: modelsOf(doc, pid).filter(
          (m) =>
            typeof m.id === "string" &&
            (!q ||
              pid.toLowerCase().includes(q) ||
              m.id.toLowerCase().includes(q) ||
              String(m.name ?? "").toLowerCase().includes(q)),
        ),
      }))
      .filter((g) => g.models.length);
  }, [doc, query]);

  const first = groups[0];
  return (
    <DialogShell
      title="新会话默认模型"
      subtitle="写入 settings.json 的 defaultProvider / defaultModel"
      onClose={onClose}
      tools={
        <DialogSearch
          value={query}
          onChange={setQuery}
          placeholder="供应商或模型"
          onEnter={() => first && onPick(first.pid, first.models[0].id as string)}
        />
      }
    >
      {groups.length === 0 ? (
        <div className="px-4 py-12 text-center text-label text-[var(--fg-3)]">没有匹配的模型</div>
      ) : (
        groups.map(({ pid, models }) => (
          <div key={pid}>
            <div className="sticky top-0 z-[1] flex gap-2 bg-[var(--popover)] px-2 pb-1 pt-3 text-mini text-[var(--fg-4)]">
              <span className="font-mono">{pid}</span>
              <span className="truncate">{hostOf(providerOf(doc, pid).baseUrl)}</span>
            </div>
            {models.map((m) => {
              const mid = m.id as string;
              const on = defaults?.provider === pid && defaults?.model === mid;
              return (
                <button
                  key={mid}
                  onClick={() => onPick(pid, mid)}
                  className={`flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-fast ease-out ${
                    on ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--hover)]"
                  }`}
                >
                  {on ? (
                    <Star className="h-[14px] w-[14px] shrink-0 text-[var(--accent)]" />
                  ) : (
                    <Dot className="h-[14px] w-[14px] shrink-0 text-[var(--fg-4)]" />
                  )}
                  <span className="truncate font-mono text-label text-[var(--fg)]">{mid}</span>
                  <span className="min-w-0 flex-1 truncate text-mini text-[var(--fg-4)]">
                    {typeof m.name === "string" ? m.name : ""}
                  </span>
                  <span className="shrink-0 font-mono text-mini text-[var(--fg-4)]">
                    {formatTokenShort(m.contextWindow)}
                  </span>
                </button>
              );
            })}
          </div>
        ))
      )}
    </DialogShell>
  );
}
