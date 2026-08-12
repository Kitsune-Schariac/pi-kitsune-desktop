import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useThemeStore, type SkinMeta } from "../../store/theme";
import { Check, FolderOpen, RefreshCw, Info } from "lucide-react";

// 不透明率 slider: 拖动实时写 CSS 变量 + 持久化 (store 内完成)
function OpacitySlider({
  label,
  value,
  min,
  max,
  onChange,
  unit = "pct",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  /** 显示单位: pct = 百分比 (不透明率), px = 像素 (模糊度) */
  unit?: "pct" | "px";
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between text-xs text-neutral-500">
        <span>{label}</span>
        <span className="tabular-nums text-neutral-600">
          {unit === "pct" ? `${Math.round(value * 100)}%` : `${Math.round(value)}px`}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer accent-primary-500"
      />
    </label>
  );
}

// 皮肤列表 + 容器不透明率 + 气泡框开关 (设置页「主题」tab)
export function ThemePanel() {
  const skins = useThemeStore((s) => s.skins);
  const activeSkinId = useThemeStore((s) => s.activeSkinId);
  const chatOpacity = useThemeStore((s) => s.chatOpacity);
  const sidebarOpacity = useThemeStore((s) => s.sidebarOpacity);
  const bubbleEnabled = useThemeStore((s) => s.bubbleEnabled);
  const bubbleOpacity = useThemeStore((s) => s.bubbleOpacity);
  const bubbleColor = useThemeStore((s) => s.bubbleColor);
  const bgBlur = useThemeStore((s) => s.bgBlur);
  const applyTheme = useThemeStore((s) => s.applyTheme);
  const setChatOpacity = useThemeStore((s) => s.setChatOpacity);
  const setSidebarOpacity = useThemeStore((s) => s.setSidebarOpacity);
  const setBubbleEnabled = useThemeStore((s) => s.setBubbleEnabled);
  const setBubbleOpacity = useThemeStore((s) => s.setBubbleOpacity);
  const setBubbleColor = useThemeStore((s) => s.setBubbleColor);
  const setBgBlur = useThemeStore((s) => s.setBgBlur);
  const reloadSkins = useThemeStore((s) => s.reloadSkins);
  // 当前激活皮肤: 判断是否有背景图 (无则模糊度禁用)
  const activeSkin = skins.find((s) => s.id === activeSkinId);
  // 切换中皮肤 id: 异步取背景图期间防连点
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onPick = async (skin: SkinMeta) => {
    if (skin.id === activeSkinId || busy) return;
    setBusy(skin.id);
    try {
      await applyTheme(skin);
    } finally {
      setBusy(null);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await reloadSkins();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-5 p-5">
      {/* 皮肤列表 */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-neutral-800">皮肤</h3>
        <div className="grid grid-cols-2 gap-3">
          {skins.map((skin) => {
            const isActive = skin.id === activeSkinId;
            return (
              <button
                key={skin.id}
                onClick={() => onPick(skin)}
                disabled={busy !== null}
                className={`group overflow-hidden rounded-xl border text-left transition ${
                  isActive
                    ? "border-primary-500 ring-2 ring-primary-500/25"
                    : "border-neutral-200 hover:border-neutral-300"
                } ${busy === skin.id ? "opacity-60" : ""}`}
                title={`${skin.name}${skin.author ? ` · ${skin.author}` : ""} v${skin.version}`}
              >
                <div className="h-24 w-full bg-neutral-100">
                  {skin.preview_data_uri ? (
                    <img
                      src={skin.preview_data_uri}
                      alt={skin.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-neutral-400">
                      无预览
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between px-2.5 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-neutral-800">{skin.name}</div>
                    <div className="text-[10px] text-neutral-400">
                      {skin.base === "dark" ? "暗色" : "浅色"}
                      {skin.author ? ` · ${skin.author}` : ""}
                    </div>
                  </div>
                  {isActive && <Check className="h-4 w-4 shrink-0 text-primary-600" />}
                </div>
              </button>
            );
          })}
        </div>
        {/* 皮肤目录入口 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void invoke("open_skins_dir")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-600 transition hover:border-neutral-300 hover:bg-neutral-100"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            打开皮肤目录
          </button>
          <button
            onClick={() => void onRefresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-600 transition hover:border-neutral-300 hover:bg-neutral-100 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            刷新皮肤列表
          </button>
          <span className="inline-flex items-center gap-1 text-[10px] text-neutral-400">
            <Info className="h-3 w-3" />
            自定义皮肤放入皮肤目录，刷新后即可切换
          </span>
        </div>
      </section>

      {/* 容器不透明率 */}
      <section className="space-y-3 border-t border-neutral-200 pt-4">
        <h3 className="text-sm font-semibold text-neutral-800">容器不透明率</h3>
        <OpacitySlider
          label="会话区"
          value={chatOpacity}
          min={0.4}
          max={0.95}
          onChange={setChatOpacity}
        />
        <OpacitySlider
          label="侧边栏"
          value={sidebarOpacity}
          min={0.2}
          max={0.9}
          onChange={setSidebarOpacity}
        />
      </section>

      {/* 背景模糊度: 无背景图的皮肤无意义, 禁用 */}
      <section className="space-y-3 border-t border-neutral-200 pt-4">
        <OpacitySlider
          label="背景模糊度"
          value={bgBlur}
          min={0}
          max={30}
          unit="px"
          onChange={setBgBlur}
        />
        {!activeSkin?.has_bg && (
          <p className="text-[10px] text-neutral-400">当前皮肤无背景图，模糊度不生效</p>
        )}
      </section>

      {/* 消息气泡框 */}
      <section className="space-y-3 border-t border-neutral-200 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-neutral-800">消息气泡框</h3>
            <p className="text-[10px] text-neutral-400">消息显示为毛玻璃气泡块，任何主题均可开关</p>
          </div>
          <button
            onClick={() => setBubbleEnabled(!bubbleEnabled)}
            aria-pressed={bubbleEnabled}
            className={`relative h-5 w-9 shrink-0 rounded-full transition ${
              bubbleEnabled ? "bg-primary-500" : "bg-neutral-300"
            }`}
          >
            <span
              className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all"
              style={{ left: bubbleEnabled ? 18 : 2 }}
            />
          </button>
        </div>
        {bubbleEnabled && (
          <>
            <OpacitySlider
              label="气泡不透明率"
              value={bubbleOpacity}
              min={0}
              max={1}
              onChange={setBubbleOpacity}
            />
            {/* 气泡底色: 选色器覆盖皮肤 --bubble-bg; null = 跟随皮肤默认 */}
            <div className="flex items-center justify-between text-xs text-neutral-500">
              <span>气泡底色</span>
              <div className="flex items-center gap-2">
                {bubbleColor && (
                  <button
                    onClick={() => setBubbleColor(null)}
                    className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500 transition hover:bg-neutral-100"
                  >
                    跟随皮肤
                  </button>
                )}
                <label className="relative inline-flex h-6 w-10 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-neutral-200">
                  <span
                    className="absolute inset-0"
                    style={{ background: bubbleColor ?? "rgb(var(--bubble-bg))" }}
                  />
                  <input
                    type="color"
                    value={bubbleColor ?? "#ffffff"}
                    onChange={(e) => setBubbleColor(e.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </label>
                <span className="tabular-nums text-neutral-600">
                  {bubbleColor ?? "皮肤默认"}
                </span>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
