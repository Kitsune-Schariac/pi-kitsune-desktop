// 外观 store: 只有日间 (白) / 夜间 (黑) 两套配色, 外加「跟随系统」。
// 颜色全部在 index.css 的 [data-base="light|dark"] 两组 token 里, 这里只负责决定 <html data-base>。
// 皮肤包系统已移除 —— 多套皮肤各自一套配色策略, 组件层很难做到处处一致。
import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const MODE_KEY = "kitsune.themeMode";
// 已作废的旧键, 启动时清理 (皮肤 id、气泡与不透明度偏好、壁纸暗幕)
const LEGACY_SKIN_KEY = "kitsune.activeSkin";
const LEGACY_KEYS = [
  LEGACY_SKIN_KEY,
  "kitsune.bubbleEnabled",
  "kitsune.bubbleOpacity",
  "kitsune.bubbleColor",
  "kitsune.bubblePrefs",
  "kitsune.chatOpacity",
  "kitsune.sidebarOpacity",
  "kitsune.bgBlur",
  "kitsune.scrim",
];
// 旧版内置皮肤里 base=dark 的几套: 升级后沿用夜间模式, 不让老用户被突然切成白底
const LEGACY_DARK_SKINS = new Set(["amber", "gold", "graphite", "jade"]);

const media = (): MediaQueryList | null =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function readMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    const legacy = localStorage.getItem(LEGACY_SKIN_KEY);
    if (legacy) return LEGACY_DARK_SKINS.has(legacy) ? "dark" : "light";
  } catch {
    // localStorage 不可用 (隐私模式等): 回落默认
  }
  return "light";
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return media()?.matches ? "dark" : "light";
  return mode;
}

/** 写 <html data-base>; animate=true 时给根容器一个短淡入, 掩盖底色瞬切 */
function apply(theme: ResolvedTheme, animate: boolean) {
  const el = document.documentElement;
  if (el.dataset.base === theme) return;
  el.dataset.base = theme;
  if (animate) {
    document.getElementById("app-root")?.animate([{ opacity: 0.6 }, { opacity: 1 }], {
      duration: 200,
      easing: "ease-out",
    });
  }
}

interface ThemeStore {
  mode: ThemeMode;
  /** 实际生效的明暗: 驱动 Shiki 主题与桌宠气泡 */
  resolved: ResolvedTheme;
  init: () => void;
  setMode: (mode: ThemeMode) => void;
}

let initialized = false;

export const useThemeStore = create<ThemeStore>((set, get) => {
  const mode = readMode();
  return {
    mode,
    resolved: resolve(mode),

    /** 启动: 迁移旧偏好 → 应用 → 监听系统明暗 (仅 system 模式下生效) */
    init: () => {
      if (initialized) return;
      initialized = true;
      const m = get().mode;
      try {
        localStorage.setItem(MODE_KEY, m);
        for (const k of LEGACY_KEYS) localStorage.removeItem(k);
      } catch {
        // 忽略
      }
      apply(get().resolved, false);
      media()?.addEventListener("change", () => {
        if (get().mode !== "system") return;
        const r = resolve("system");
        apply(r, true);
        set({ resolved: r });
      });
    },

    setMode: (next) => {
      const r = resolve(next);
      apply(r, true);
      set({ mode: next, resolved: r });
      try {
        localStorage.setItem(MODE_KEY, next);
      } catch {
        // 忽略
      }
    },
  };
});
