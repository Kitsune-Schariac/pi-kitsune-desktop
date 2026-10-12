import { useMemo, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SKIN_ID, useThemeStore, type SkinMeta } from "../../store/theme";
import { Check, FolderOpen, RefreshCw, Info, Moon, Sun } from "lucide-react";

// 设置分区标题: label 档 + 半粗 + 三级文字色 (与检查器 .ov-title 同一口径)
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-label font-semibold text-fg-3">
      {children}
    </h3>
  );
}

// 皮肤骨架预览: 按皮肤 colors 画一张没有文字的界面缩略图 (图标轨 / 会话列表 / 时间线 / 输入框)。
// 根元素挂 data-base, 直接命中 index.css 里 [data-base] 的整套默认 token,
// 皮肤 colors 再以 inline 变量覆盖 —— 与 applyTheme 写 :root 的层叠关系一致, 不在 TS 里复制默认值。
// 取代原 preview 截图: 截图带真实会话内容, 且自定义皮肤得手动截
function SkinSkeleton({ skin }: { skin: SkinMeta }) {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(skin.colors)) vars[`--${k}`] = v;
  return (
    <div className="sk" data-base={skin.base} style={vars as CSSProperties} aria-hidden>
      <div className="sk-rail">
        <i className="on" />
        <i />
        <i />
      </div>
      <div className="sk-pane">
        <i className="w-70" />
        <i className="on w-85" />
        <i className="w-60" />
        <i className="w-75" />
        <i className="w-50" />
      </div>
      <div className="sk-main">
        <div className="sk-prompt" />
        <i className="w-90" />
        <i className="w-75" />
        <i className="w-85" />
        <div className="sk-codeblock" />
        <div className="sk-input">
          <span />
        </div>
      </div>
    </div>
  );
}

// 主题列表 (设置页「主题」tab)
export function ThemePanel() {
  const skins = useThemeStore((s) => s.skins);
  const activeSkinId = useThemeStore((s) => s.activeSkinId);
  const applyTheme = useThemeStore((s) => s.applyTheme);
  const reloadSkins = useThemeStore((s) => s.reloadSkins);
  // 切换中皮肤 id: applyTheme 异步取 override.css 期间防连点
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Rust 侧按「亮色在前 + id」排序, 默认主题再提到第一位
  const ordered = useMemo(
    () => [
      ...skins.filter((s) => s.id === DEFAULT_SKIN_ID),
      ...skins.filter((s) => s.id !== DEFAULT_SKIN_ID),
    ],
    [skins],
  );

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
      <section>
        <SectionTitle>主题</SectionTitle>
        <p className="-mt-1 mb-3 text-body text-fg-2">切换即时生效。</p>
        <div className="grid grid-cols-2 gap-3">
          {ordered.map((skin) => {
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
                <div className="h-28 w-full">
                  <SkinSkeleton skin={skin} />
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
                      {skin.author && <span className="truncate">{skin.author}</span>}
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
    </div>
  );
}
