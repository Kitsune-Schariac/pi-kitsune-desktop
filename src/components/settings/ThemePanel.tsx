import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useThemeStore, type SkinMeta } from "../../store/theme";
import { Check, FolderOpen, RefreshCw, Info, Moon, Sun } from "lucide-react";

// 不透明率 slider: 拖动实时写 CSS 变量 + 持久化 (store 内完成)
function OpacitySlider({
  label,
  value,
  min,
  max,
  onChange,
  unit = "pct",
  disabled = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  /** 显示单位: pct = 百分比 (不透明率), px = 像素 (模糊度) */
  unit?: "pct" | "px";
  /** 禁用: 无背景图皮肤下不透明率是视觉空操作 */
  disabled?: boolean;
}) {
  return (
    <label className={`block ${disabled ? "opacity-50" : ""}`}>
      <div className="mb-1 flex items-center justify-between text-label text-[var(--muted)]">
        <span>{label}</span>
        <span className="tabular-nums text-[var(--fg)]">
          {unit === "pct" ? `${Math.round(value * 100)}%` : `${Math.round(value)}px`}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`w-full accent-[var(--accent)] ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      />
    </label>
  );
}

// 设置分区标题: mini 档 + mono + 大写 + faint (对齐改版稿 .set-sec > h3)
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 font-mono text-mini font-semibold uppercase tracking-[0.09em] text-[var(--faint)]">
      {children}
    </h3>
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
    <div className="space-y-6 p-6">
      {/* 皮肤 · 背景 */}
      <section>
        <SectionTitle>皮肤 · 背景</SectionTitle>
        <p className="-mt-1 mb-3 text-body text-[var(--muted)]">
          皮肤即主题：背景图 + 强调色 + 界面基调。切换即时生效。
        </p>
        <div className="grid grid-cols-2 gap-3">
          {skins.map((skin) => {
            const isActive = skin.id === activeSkinId;
            return (
              <button
                key={skin.id}
                onClick={() => onPick(skin)}
                disabled={busy !== null}
                aria-pressed={isActive}
                className={`group overflow-hidden rounded-md border text-left transition duration-fast ease-out ${
                  isActive
                    ? "border-[var(--accent)] ring-2 ring-[color-mix(in_oklch,var(--accent)_25%,transparent)]"
                    : "border-[var(--border-soft)] hover:border-[var(--border)]"
                } ${busy === skin.id ? "opacity-60" : ""}`}
                title={`${skin.name}${skin.author ? ` · ${skin.author}` : ""} v${skin.version}`}
              >
                <div className="h-24 w-full bg-[var(--surface-2)]">
                  {skin.preview_data_uri ? (
                    <img
                      src={skin.preview_data_uri}
                      alt={skin.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-mini text-[var(--faint)]">
                      无预览
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 bg-[var(--surface)] px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-label font-medium text-[var(--fg)]">{skin.name}</div>
                    <div className="flex items-center gap-1 text-mini text-[var(--faint)]">
                      {skin.base === "dark" ? (
                        <Moon className="h-3 w-3" />
                      ) : (
                        <Sun className="h-3 w-3" />
                      )}
                      <span>{skin.base === "dark" ? "暗色" : "浅色"}</span>
                      {skin.author ? ` · ${skin.author}` : ""}
                    </div>
                  </div>
                  {isActive && <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
                </div>
              </button>
            );
          })}
        </div>
        {/* 皮肤目录入口 */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void invoke("open_skins_dir")}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--border-soft)] px-3 py-2 text-mini text-[var(--muted)] transition duration-fast ease-out hover:border-[var(--border)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
          >
            <FolderOpen className="h-4 w-4" />
            打开皮肤目录
          </button>
          <button
            onClick={() => void onRefresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--border-soft)] px-3 py-2 text-mini text-[var(--muted)] transition duration-fast ease-out hover:border-[var(--border)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)] disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            刷新皮肤列表
          </button>
          <span className="inline-flex items-center gap-1 text-mini text-[var(--faint)]">
            <Info className="h-3 w-3" />
            自定义皮肤放入皮肤目录，刷新后即可切换
          </span>
        </div>
      </section>

      {/* 透明度 */}
      <section className="space-y-3 border-t border-[var(--border-soft)] pt-5">
        <SectionTitle>透明度</SectionTitle>
        <p className="-mt-1 mb-2 text-body text-[var(--muted)]">
          控制壁纸透过面板的可见程度。
        </p>
        <OpacitySlider
          label="会话区"
          value={chatOpacity}
          min={0.4}
          max={0.95}
          onChange={setChatOpacity}
          disabled={!activeSkin?.has_bg}
        />
        <OpacitySlider
          label="侧边栏"
          value={sidebarOpacity}
          min={0.2}
          max={0.9}
          onChange={setSidebarOpacity}
          disabled={!activeSkin?.has_bg}
        />
        {!activeSkin?.has_bg && (
          <p className="text-mini text-[var(--faint)]">当前皮肤无背景图，不透明率不生效</p>
        )}
      </section>

      {/* 背景模糊度: 无背景图的皮肤无意义, 禁用 */}
      <section className="space-y-3 border-t border-[var(--border-soft)] pt-5">
        <SectionTitle>背景模糊度</SectionTitle>
        <OpacitySlider
          label="模糊半径"
          value={bgBlur}
          min={0}
          max={30}
          unit="px"
          onChange={setBgBlur}
        />
        {!activeSkin?.has_bg && (
          <p className="text-mini text-[var(--faint)]">当前皮肤无背景图，模糊度不生效</p>
        )}
      </section>

      {/* 对话气泡 */}
      <section className="space-y-3 border-t border-[var(--border-soft)] pt-5">
        <div className="flex items-center justify-between">
          <div>
            <SectionTitle>对话气泡</SectionTitle>
            <p className="-mt-1 text-mini text-[var(--faint)]">
              消息显示为毛玻璃气泡块；这组设置按皮肤分别保存，切换皮肤会切到对应皮肤的记忆
            </p>
          </div>
          <button
            onClick={() => setBubbleEnabled(!bubbleEnabled)}
            aria-pressed={bubbleEnabled}
            className={`relative h-5 w-9 shrink-0 rounded-full transition duration-fast ease-out ${
              bubbleEnabled ? "bg-[var(--accent)]" : "bg-[var(--surface-2)] ring-1 ring-inset ring-[var(--border-soft)]"
            }`}
          >
            <span
              className="absolute top-1 h-4 w-4 rounded-full bg-[var(--panel)] shadow-sm transition-[left] duration-base ease-swift"
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
            <div className="flex items-center justify-between text-label text-[var(--muted)]">
              <span>气泡底色</span>
              <div className="flex items-center gap-2">
                {bubbleColor && (
                  <button
                    onClick={() => setBubbleColor(null)}
                    className="rounded-md border border-[var(--border-soft)] px-2 py-1 text-mini text-[var(--muted)] transition duration-fast ease-out hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
                  >
                    跟随皮肤
                  </button>
                )}
                <label className="relative inline-flex h-6 w-10 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-[var(--border-soft)]">
                  <span
                    className="absolute inset-0"
                    style={{ background: bubbleColor ?? "var(--bubble-bg)" }}
                  />
                  <input
                    type="color"
                    value={bubbleColor ?? "#ffffff"}
                    onChange={(e) => setBubbleColor(e.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </label>
                <span className="tabular-nums text-mini text-[var(--faint)]">
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
