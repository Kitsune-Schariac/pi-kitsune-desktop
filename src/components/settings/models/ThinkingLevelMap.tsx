// 思考档位映射带: pi 的 7 个思考档位分别发给供应商什么值 (thinkingLevelMap)。
// 每档三态: 省略 = 默认映射 / 字符串 = 自定义发送值 / null = 显式不支持 (选择器里隐藏该档)。
import { useMemo, useRef, useState } from "react";
import { Info, X } from "lucide-react";
import {
  THINKING_LEVELS,
  isObj,
  modelsOf,
  providerIds,
  useModelsConfigStore,
  type JsonObject,
} from "../../../store/modelsConfig";
import { Input, Segmented } from "../../ui";
import { LINK, useEscapeLayer } from "./shared";

type Level = (typeof THINKING_LEVELS)[number];
type LevelState = "default" | "custom" | "null" | "bad";
const LEVELS: readonly string[] = THINKING_LEVELS;

interface LevelInfo {
  st: LevelState;
  text: string;
  title: string;
}

function levelInfo(map: unknown, l: string): LevelInfo {
  const has = isObj(map) && l in map;
  if (!has) {
    // xhigh / max 不在 pi 的默认映射里: 不写就等于这一档不可用
    return l === "xhigh" || l === "max"
      ? { st: "default", text: "—", title: `${l}: 不写 = 不可用` }
      : { st: "default", text: l, title: `${l}: 默认按档名发送` };
  }
  const v = (map as JsonObject)[l];
  if (v === null) return { st: "null", text: "不支持", title: `${l}: 显式不支持` };
  if (typeof v === "string") return { st: "custom", text: v || "…", title: `${l} → 发送 ${v}` };
  return { st: "bad", text: "异常", title: `${l}: 值不是字符串也不是 null, 去 JSON 修` };
}

/** 只保留已知 7 档并按固定顺序排列, 用于写法比较与套用 */
function normalizeMap(map: unknown): JsonObject {
  if (!isObj(map)) return {};
  return Object.fromEntries(LEVELS.filter((l) => l in map).map((l) => [l, map[l]]));
}

const CELL_VALUE: Record<LevelState, string> = {
  default: "text-[var(--fg-4)]",
  custom: "font-semibold text-[var(--accent)]",
  null: "text-[var(--fg-4)] line-through decoration-[var(--fg-4)]",
  bad: "text-[var(--err)]",
};
const NULL_STRIPES = "bg-[repeating-linear-gradient(135deg,transparent_0_5px,var(--hover)_5px_6px)]";

export function ThinkingLevelMap({ pid, mid, model }: { pid: string; mid: string; model: JsonObject }) {
  const docBase = useModelsConfigStore((s) => s.docBase);
  const doc = useModelsConfigStore((s) => s.doc);
  const setModelLevelEntry = useModelsConfigStore((s) => s.setModelLevelEntry);
  const setModelField = useModelsConfigStore((s) => s.setModelField);
  const [sel, setSel] = useState<Level | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const valueRef = useRef<HTMLInputElement>(null);
  useEscapeLayer(sel !== null, () => setSel(null));

  const map = model.thinkingLevelMap;
  const mapBad = map !== undefined && !isObj(map);
  const current = JSON.stringify(normalizeMap(map));

  // 常用写法从加载时的配置统计 (不随正在进行的编辑跳动), 取出现次数最多的 4 种
  const presets = useMemo(() => {
    const source = docBase ?? doc;
    const count = new Map<string, { map: JsonObject; n: number }>();
    for (const p of providerIds(source)) {
      for (const m of modelsOf(source, p)) {
        const norm = normalizeMap(m.thinkingLevelMap);
        if (!Object.keys(norm).length) continue;
        const key = JSON.stringify(norm);
        const hit = count.get(key);
        if (hit) hit.n++;
        else count.set(key, { map: norm, n: 1 });
      }
    }
    return [...count.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 4)
      .map(([key, v]) => ({ key, ...v }));
  }, [docBase, doc]);

  // 套用 / 全部默认只替换 7 个已知档, 本版本不认识的档位键原样保留
  const applyPreset = (preset: JsonObject) => {
    const unknown = isObj(map) ? Object.fromEntries(Object.entries(map).filter(([k]) => !LEVELS.includes(k))) : {};
    const next = { ...structuredClone(preset), ...unknown };
    setModelField(pid, mid, "thinkingLevelMap", Object.keys(next).length ? next : null);
    setSel(null);
  };

  const setState = (l: Level, st: LevelState) => {
    if (st === "default") setModelLevelEntry(pid, mid, l, undefined);
    else if (st === "null") setModelLevelEntry(pid, mid, l, null);
    else if (st === "custom") {
      const cur = isObj(map) ? map[l] : undefined;
      if (typeof cur !== "string") setModelLevelEntry(pid, mid, l, l);
      requestAnimationFrame(() => {
        valueRef.current?.focus();
        valueRef.current?.select();
      });
    }
  };

  if (mapBad) {
    return (
      <span className="flex items-start gap-2 text-mini text-[var(--err)]">
        <Info className="mt-[2px] h-3 w-3 shrink-0" />
        thinkingLevelMap 不是对象, 只能在 JSON 模式里修正
      </span>
    );
  }

  const selInfo = sel ? levelInfo(map, sel) : null;
  const selValue = sel && isObj(map) && typeof map[sel] === "string" ? (map[sel] as string) : "";

  return (
    <>
      <div className={`flex flex-col gap-3 ${model.reasoning === true ? "" : "opacity-60"}`}>
        {model.reasoning !== true && (
          <span className="flex items-start gap-2 text-mini text-[var(--fg-4)]">
            <Info className="mt-[2px] h-3 w-3 shrink-0" />
            没开「推理」能力, 这组映射不会生效。
          </span>
        )}
        <div className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-2">
          <div className="flex flex-col gap-1 py-2 text-right text-mini leading-snug text-[var(--fg-4)]">
            <span>pi 档位</span>
            <span>发送</span>
          </div>
          <div className="grid grid-cols-7 overflow-hidden rounded-md border border-[var(--line)] bg-[var(--well)]">
            {THINKING_LEVELS.map((l) => {
              const info = levelInfo(map, l);
              const on = sel === l;
              return (
                <button
                  key={l}
                  title={info.title}
                  onClick={() => setSel(on ? null : l)}
                  className={`flex min-w-0 flex-col items-center gap-1 border-r border-[var(--line)] px-[2px] py-2 transition-colors duration-fast ease-out last:border-r-0 ${
                    on
                      ? "bg-[var(--accent-soft)] shadow-[inset_0_-2px_0_var(--accent)]"
                      : info.st === "null"
                        ? `${NULL_STRIPES} hover:bg-[var(--hover)]`
                        : "hover:bg-[var(--hover)]"
                  }`}
                >
                  <span className="font-mono text-mini text-[var(--fg-4)]">{l}</span>
                  <span className={`max-w-full truncate px-[2px] font-mono text-label ${CELL_VALUE[info.st]}`}>
                    {info.text}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {sel && selInfo ? (
          <div className="flex flex-col gap-2 rounded-md bg-[var(--well)] px-3 py-2 shadow-[inset_0_0_0_1px_var(--line)]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-label font-semibold text-[var(--fg)]">{sel}</span>
              <span className="text-label text-[var(--fg-4)]">档发送</span>
              <Segmented
                size="sm"
                value={selInfo.st === "bad" ? null : selInfo.st}
                onChange={(st) => setState(sel, st)}
                options={[
                  { value: "default", label: "默认" },
                  { value: "custom", label: "自定义" },
                  { value: "null", label: "不支持" },
                ]}
              />
              <span className="flex-1" />
              <button
                onClick={() => setSel(null)}
                title="收起 (Esc)"
                className="grid h-6 w-6 place-items-center rounded-sm text-[var(--fg-3)] hover:bg-[var(--hover)] hover:text-[var(--fg)]"
              >
                <X className="h-[14px] w-[14px]" />
              </button>
            </div>
            {selInfo.st === "custom" ? (
              <>
                <Input
                  ref={valueRef}
                  className="max-w-[220px] font-mono"
                  value={selValue}
                  placeholder="发给供应商的值"
                  onChange={(e) => setModelLevelEntry(pid, mid, sel, e.target.value)}
                  onBlur={(e) => {
                    // 清空 = 回到默认映射; 存空串会让 pi 把空字符串原样发给供应商
                    if (!e.target.value.trim()) setModelLevelEntry(pid, mid, sel, undefined);
                  }}
                />
                <div className="flex flex-wrap gap-1">
                  {THINKING_LEVELS.slice(1).map((v) => (
                    <button
                      key={v}
                      onClick={() => setModelLevelEntry(pid, mid, sel, v)}
                      className={`h-6 rounded-[6px] border px-2 font-mono text-mini transition-colors duration-fast ease-out ${
                        selValue === v
                          ? "border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                          : "border-[var(--line)] bg-[var(--well)] text-[var(--fg-3)] hover:border-[var(--line-2)] hover:text-[var(--fg)]"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <span className="text-mini leading-relaxed text-[var(--fg-4)]">
                {selInfo.st === "null"
                  ? "显式声明不支持, 思考档位选择器里隐藏这一档。"
                  : selInfo.st === "bad"
                    ? "值不是字符串也不是 null, 选一种状态覆盖它, 或切到 JSON 修正。"
                    : sel === "xhigh" || sel === "max"
                      ? "不写 = 这一档不可用, 选择器里不出现。"
                      : `不写 = 按档名原样发送「${sel}」。`}
              </span>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-mini text-[var(--fg-4)]">
            <span>点档位修改</span>
            <span className="inline-flex items-center gap-1">
              <i className="inline-block h-[10px] w-[10px] rounded-[3px] bg-[var(--accent)]" />
              自定义
            </span>
            <span className="inline-flex items-center gap-1">
              <i className="inline-block h-[10px] w-[10px] rounded-[3px] border border-[var(--line-2)]" />
              默认
            </span>
            <span className="inline-flex items-center gap-1">
              <i className="inline-block h-[10px] w-[10px] rounded-[3px] border border-[var(--line-2)] bg-[repeating-linear-gradient(135deg,transparent_0_2px,var(--fg-4)_2px_3px)]" />
              不支持
            </span>
          </div>
        )}
      </div>

      <div>
        <button
          onClick={() => setPresetsOpen((v) => !v)}
          className={LINK}
        >
          {presetsOpen ? "收起常用写法" : "套用常用写法…"}
        </button>
      </div>
      {presetsOpen && (
        <div className="flex flex-col gap-1">
          {presets.map((p) => (
            <PresetRow
              key={p.key}
              map={p.map}
              current={p.key === current}
              note={`${p.key === current ? "当前 · " : ""}${p.n} 个模型在用`}
              onApply={() => applyPreset(p.map)}
            />
          ))}
          <PresetRow map={{}} current={current === "{}"} note="全部默认" onApply={() => applyPreset({})} />
        </div>
      )}
    </>
  );
}

function PresetRow({
  map,
  current,
  note,
  onApply,
}: {
  map: JsonObject;
  current: boolean;
  note: string;
  onApply: () => void;
}) {
  return (
    <button
      onClick={onApply}
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-2 py-1 text-left transition-colors duration-fast ease-out hover:bg-[var(--hover)] ${
        current
          ? "border-[color-mix(in_oklch,var(--accent)_45%,transparent)]"
          : "border-[var(--line)] hover:border-[var(--line-2)]"
      }`}
    >
      <span className="grid grid-cols-7 gap-[2px]">
        {THINKING_LEVELS.map((l) => {
          const info = levelInfo(map, l);
          return (
            <span
              key={l}
              title={info.title}
              className={`truncate rounded-sm py-[1px] text-center font-mono text-mini ${
                info.st === "custom"
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : info.st === "null"
                    ? "text-[var(--fg-4)] line-through"
                    : "text-[var(--fg-4)]"
              }`}
            >
              {info.text}
            </span>
          );
        })}
      </span>
      <span className="whitespace-nowrap text-mini text-[var(--fg-4)]">{note}</span>
    </button>
  );
}
