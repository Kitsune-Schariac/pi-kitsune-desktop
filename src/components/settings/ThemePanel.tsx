import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useThemeStore, type SkinMeta } from "../../store/theme";
import { Check, FolderOpen, RefreshCw, Info, Moon, Sun } from "lucide-react";

// 浓度 slider: 拖动实时写 CSS 变量 + 持久化 (store 内完成)
function OpacitySlider({
  label,
  value,
  min,
  max,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  /** 禁用: 纯色皮肤下暗幕是视觉空操作 */
  disabled?: boolean;
}) {
  return (
    <label className={`block ${disabled ? "opacity-50" : ""}`}>
      <div className="mb-1 flex items-center justify-between text-label text-fg-2">
        <span>{label}</span>
        <span className="tabular-nums text-fg">{Math.round(value * 100)}%</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`w-full ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      />
    </label>
  );
}

// 设置分区标题: label 档 + 半粗 + 三级文字色 (与检查器 .ov-title 同一口径)
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-label font-semibold text-fg-3">
      {children}
    </h3>
  );
}

// 皮肤列表 + 暗幕浓度 (设置页「主题」tab)
export function ThemePanel() {
  const skins = useThemeStore((s) => s.skins);
  const activeSkinId = useThemeStore((s) => s.activeSkinId);
  const scrim = useThemeStore((s) => s.scrim);
  const applyTheme = useThemeStore((s) => s.applyTheme);
  const setScrim = useThemeStore((s) => s.setScrim);
  const reloadSkins = useThemeStore((s) => s.reloadSkins);
  // 当前激活皮肤: 判断是壁纸(舞台)还是纯色(工坊)皮肤, 决定暗幕滑杆可用性
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
      {/* 皮肤 · 风格 */}
      <section>
        <SectionTitle>皮肤 · 风格</SectionTitle>
        <p className="-mt-1 mb-3 text-body text-fg-2">
          皮肤即主题：壁纸皮肤走「壁纸舞台」风格，纯色皮肤走「狐火工坊」风格。切换即时生效。
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
                className={`group overflow-hidden rounded-lg border text-left transition duration-fast ease-out ${
                  isActive
                    ? "border-[var(--accent)] ring-2 ring-[var(--accent-soft)]"
                    : "border-[var(--line)] hover:border-[var(--line-2)]"
                } ${busy === skin.id ? "opacity-60" : ""}`}
                title={`${skin.name}${skin.author ? ` · ${skin.author}` : ""} v${skin.version}`}
              >
                <div className="h-24 w-full bg-[var(--well)]">
                  {skin.preview_data_uri ? (
                    <img
                      src={skin.preview_data_uri}
                      alt={skin.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-mini text-fg-4">
                      无预览
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] bg-[var(--raise)] px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-label font-medium text-fg">{skin.name}</div>
                    <div className="flex items-center gap-1 text-mini text-fg-4">
                      {skin.base === "dark" ? (
                        <Moon className="h-3 w-3" />
                      ) : (
                        <Sun className="h-3 w-3" />
                      )}
                      <span>
                        {skin.has_bg ? "舞台" : "工坊"} · {skin.base === "dark" ? "暗" : "亮"}
                      </span>
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
            className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 text-mini text-fg-2 transition duration-fast ease-out hover:border-[var(--line-2)] hover:bg-[var(--hover)] hover:text-fg"
          >
            <FolderOpen className="h-4 w-4" />
            打开皮肤目录
          </button>
          <button
            onClick={() => void onRefresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 text-mini text-fg-2 transition duration-fast ease-out hover:border-[var(--line-2)] hover:bg-[var(--hover)] hover:text-fg disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            刷新皮肤列表
          </button>
          <span className="inline-flex items-center gap-1 text-mini text-fg-4">
            <Info className="h-3 w-3" />
            自定义皮肤放入皮肤目录，刷新后即可切换
          </span>
        </div>
      </section>

      {/* 暗幕浓度: 合并旧「会话区/侧栏不透明率 + 背景模糊」三滑杆, 仅壁纸舞台生效 */}
      <section className="space-y-3 border-t border-[var(--line)] pt-5">
        <SectionTitle>暗幕浓度</SectionTitle>
        <p className="-mt-1 mb-2 text-body text-fg-2">
          控制舞台暗幕（浅色皮肤为白幕）的浓度，面板与文字的可读性靠它拉开。
        </p>
        <OpacitySlider
          label="浓度"
          value={scrim}
          min={0.5}
          max={0.95}
          onChange={setScrim}
          disabled={!activeSkin?.has_bg}
        />
        {!activeSkin?.has_bg && (
          <p className="text-mini text-fg-4">仅壁纸皮肤生效</p>
        )}
      </section>
    </div>
  );
}
