import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Check, Pipette } from "lucide-react";
import { useThemeStore } from "../../store/theme";
import { ACCENT_PRESETS, accentHex, deriveAccent, hexToHsv, hsvToHex, normalizeHex } from "../../lib/accent";
import { Button, Input, Switch } from "../ui";

// 设置 · 外观 · 强调色: 预设色板 + 自定义调色盘 + 日间 / 夜间实际效果预览。
// 选色即时生效 (整个界面跟着变), 不设「应用」按钮 —— 与配色模式卡片的交互一致。

const MONO_SWATCH = "linear-gradient(135deg, #1a1a1a 0 50%, #ededed 50% 100%)";
const RAINBOW = "conic-gradient(from 0deg, #ff3b30, #ff9500, #ffcc00, #34c759, #00c7be, #0a84ff, #5e5ce6, #bf5af2, #ff3b30)";
const HUE_BAR = "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";

export function AccentPicker() {
  const accent = useThemeStore((s) => s.accent);
  const customAccent = useThemeStore((s) => s.customAccent);
  const setAccent = useThemeStore((s) => s.setAccent);
  const isCustom = !ACCENT_PRESETS.some((p) => p.id === accent);
  // 调色盘开合独立于「是否自定义」: 点自定义色块即打开; 选回预设自动收起
  const [paletteOpen, setPaletteOpen] = useState(isCustom);
  const showPalette = paletteOpen && isCustom;

  const current = accentHex(accent);
  const currentName = isCustom ? "自定义" : ACCENT_PRESETS.find((p) => p.id === accent)?.name;

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap gap-x-3 gap-y-4" role="radiogroup" aria-label="强调色">
          {ACCENT_PRESETS.map((p) => (
            <Swatch
              key={p.id}
              label={p.name}
              background={p.hex ?? MONO_SWATCH}
              ring={p.hex ?? "var(--fg)"}
              selected={accent === p.id}
              onClick={() => {
                setAccent(p.id);
                setPaletteOpen(false);
              }}
            />
          ))}
          <Swatch
            label="自定义"
            background={RAINBOW}
            // 自定义已选中: 彩虹环里嵌当前色, 一眼看出选的是什么
            inner={isCustom ? accent : undefined}
            ring={isCustom ? accent : "var(--fg-3)"}
            selected={isCustom}
            icon={!isCustom}
            onClick={() => {
              if (!isCustom) setAccent(customAccent);
              setPaletteOpen((v) => (isCustom ? !v : true));
            }}
          />
        </div>
        <div className="mt-4 flex items-center gap-2 text-label text-fg-4">
          <span>当前</span>
          <span className="text-fg-2">{currentName}</span>
          {current && <span className="font-mono uppercase">{current}</span>}
          {!current && <span>· 日间黑 / 夜间白, 不带彩色</span>}
        </div>
        {showPalette && <Palette key="palette" initial={customAccent} onChange={setAccent} />}
      </div>
      <AccentPreview />
    </div>
  );
}

/** 一枚色块: 32px 圆 + 下方名称; 选中 = 外圈色环 + 勾 */
function Swatch({
  label,
  background,
  ring,
  inner,
  selected,
  icon = false,
  onClick,
}: {
  label: string;
  background: string;
  ring: string;
  inner?: string;
  selected: boolean;
  icon?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="group flex w-12 flex-col items-center gap-2 rounded-md"
    >
      <span
        className="relative grid h-8 w-8 place-items-center rounded-full transition-transform duration-fast ease-out group-hover:scale-105"
        style={{
          background,
          // 选中: 底色描一圈留白再套色环 (色环与色块分开, 浅色块也看得清选中)
          boxShadow: selected
            ? `0 0 0 2px var(--card), 0 0 0 4px ${ring}`
            : "inset 0 0 0 1px rgba(0, 0, 0, 0.08)",
        }}
      >
        {inner && (
          <span
            className="h-[22px] w-[22px] rounded-full"
            style={{ background: inner, boxShadow: "0 0 0 2px var(--card)" }}
          />
        )}
        {/* 勾一律白色 + 淡投影: 深浅色块 (含墨的黑白对半) 上都看得清, 不随色块变色 */}
        {selected && (
          <Check
            className={`absolute text-white [filter:drop-shadow(0_1px_1px_rgba(0,0,0,0.45))] ${inner ? "h-3 w-3" : "h-4 w-4"}`}
            strokeWidth={3.5}
          />
        )}
        {icon && <Pipette className="h-[14px] w-[14px] text-white drop-shadow" />}
      </span>
      <span className={`text-meta ${selected ? "text-fg" : "text-fg-4 group-hover:text-fg-2"}`}>{label}</span>
    </button>
  );
}

/**
 * 调色盘: 饱和度 × 明度方块 + 色相条 + 十六进制输入。
 * 内部按 HSV 存状态 (不由 hex 反推): 拖到纯黑 / 纯灰时色相不会丢, 拖回来还是原来的色相。
 * 拖动即写入 store —— 整个界面实时跟着变色, 就是最好的预览。
 */
function Palette({ initial, onChange }: { initial: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(initial));
  const [draft, setDraft] = useState(initial);
  const hex = hsvToHex(hsv.h, hsv.s, hsv.v);

  const commit = (next: { h: number; s: number; v: number }) => {
    setHsv(next);
    const h = hsvToHex(next.h, next.s, next.v);
    setDraft(h);
    onChange(h);
  };

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

  const fromSv = (e: PointerEvent) => {
    const r = svRef.current!.getBoundingClientRect();
    commit({ ...hsv, s: clamp01((e.clientX - r.left) / r.width), v: 1 - clamp01((e.clientY - r.top) / r.height) });
  };
  const fromHue = (e: PointerEvent) => {
    const r = hueRef.current!.getBoundingClientRect();
    // 360 与 0 是同一个红: 封顶 359.9, 拖到最右不会跳回最左
    commit({ ...hsv, h: Math.min(359.9, clamp01((e.clientX - r.left) / r.width) * 360) });
  };

  // 指针捕获: 拖出方块外仍持续取值, 松手自动释放
  const drag = (handler: (e: PointerEvent) => void) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      handler(e);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) handler(e);
    },
  });

  // 键盘: 方向键微调, Shift 加大步长 (读屏 / 不便拖动时也能精确取色)
  const svKey = (e: KeyboardEvent) => {
    const d = e.shiftKey ? 0.1 : 0.02;
    const map: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
    const step = map[e.key];
    if (!step) return;
    e.preventDefault();
    commit({ ...hsv, s: clamp01(hsv.s + step[0]), v: clamp01(hsv.v + step[1]) });
  };
  const hueKey = (e: KeyboardEvent) => {
    const d = e.shiftKey ? 15 : 2;
    const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -d : e.key === "ArrowRight" || e.key === "ArrowUp" ? d : 0;
    if (!delta) return;
    e.preventDefault();
    commit({ ...hsv, h: (hsv.h + delta + 360) % 360 });
  };

  const applyDraft = () => {
    const h = normalizeHex(draft);
    if (!h) {
      setDraft(hex); // 非法输入: 回到当前色, 不报错打断
      return;
    }
    const next = hexToHsv(h);
    // 灰色没有色相: 保留原色相, 之后拉饱和度时从原来的色相出来
    commit(next.s === 0 ? { ...next, h: hsv.h } : next);
  };

  const light = deriveAccent(hex, "light");
  const dark = deriveAccent(hex, "dark");

  return (
    <div className="mt-4 grid gap-5 border-t border-line pt-4 sm:grid-cols-[minmax(0,1fr)_200px]">
      <div className="min-w-0 space-y-3">
        <div
          ref={svRef}
          role="slider"
          tabIndex={0}
          aria-label="饱和度与明度 (方向键调整)"
          aria-valuetext={`饱和度 ${Math.round(hsv.s * 100)}%, 明度 ${Math.round(hsv.v * 100)}%`}
          onKeyDown={svKey}
          {...drag(fromSv)}
          className="relative h-40 cursor-crosshair touch-none select-none rounded-md"
          style={{
            background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h} 100% 50%)`,
          }}
        >
          <span
            className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
            style={{
              left: `${hsv.s * 100}%`,
              top: `${(1 - hsv.v) * 100}%`,
              background: hex,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.3)",
            }}
          />
        </div>
        <div
          ref={hueRef}
          role="slider"
          tabIndex={0}
          aria-label="色相"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          onKeyDown={hueKey}
          {...drag(fromHue)}
          className="relative h-3 cursor-pointer touch-none select-none rounded-full"
          style={{ background: HUE_BAR }}
        >
          <span
            className="pointer-events-none absolute top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
            style={{
              left: `${(hsv.h / 360) * 100}%`,
              background: `hsl(${hsv.h} 100% 50%)`,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.3)",
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span
            className="h-10 w-10 shrink-0 rounded-md"
            style={{ background: hex, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.08)" }}
            aria-hidden
          />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={applyDraft}
            onKeyDown={(e) => e.key === "Enter" && applyDraft()}
            spellCheck={false}
            aria-label="十六进制色值"
            className="font-mono uppercase"
          />
        </div>
        <div className="space-y-2 text-label">
          <div className="text-fg-4">实际效果 (按明暗微调保可读)</div>
          <AppliedChip label="日间" tokens={light} />
          <AppliedChip label="夜间" tokens={dark} />
        </div>
      </div>
    </div>
  );
}

function AppliedChip({ label, tokens }: { label: string; tokens: ReturnType<typeof deriveAccent> }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 text-fg-3">{label}</span>
      <span className="h-4 w-4 rounded-full" style={{ background: tokens.accent }} aria-hidden />
      <span className="font-mono uppercase text-fg-2">{tokens.accent}</span>
    </div>
  );
}

/**
 * 日间 / 夜间并排的小样: 子树挂 data-base, 直接命中对应那组 token (含注入的强调色),
 * 用的是真实组件 (主按钮 / 开关 / 运行点 / 链接 / 选中项), 所见即界面里的样子。
 * 只供看, 不可交互 (inert)
 */
function AccentPreview() {
  return (
    <div className="grid gap-4 sm:grid-cols-2" inert aria-hidden>
      {(["light", "dark"] as const).map((base) => (
        <div key={base} data-base={base} className="rounded-lg border border-edge bg-bg p-4 text-fg shadow-md">
          <div className="mb-3 text-meta text-fg-4">{base === "light" ? "日间" : "夜间"}</div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="sm">
              主按钮
            </Button>
            <Switch checked onChange={() => {}} />
            <span className="inline-flex items-center gap-2 text-label text-fg-2">
              <span className="live-dot" />
              运行中
            </span>
          </div>
          <p className="mt-3 text-body text-fg-2">
            正文里的
            <span className="mx-1 text-accent-2 underline decoration-[color-mix(in_srgb,var(--accent-2)_35%,transparent)] underline-offset-[3px]">
              链接
            </span>
            和
            <span className="mx-1 rounded-[6px] bg-accent-soft px-[6px] py-[1px] text-accent-2">选中项</span>
          </p>
        </div>
      ))}
    </div>
  );
}
