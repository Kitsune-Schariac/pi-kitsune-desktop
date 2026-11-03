// 外观 store: 日间 (白) / 夜间 (黑) 两套配色 + 「跟随系统」, 外加一个强调色。
// 中性色全部在 index.css 的 [data-base="light|dark"] 两组 token 里, 这里负责决定 <html data-base>;
// 强调色由 lib/accent 按明暗各推一组 --accent* token, 注入一段 <style> 覆盖 index.css 的墨色默认值。
// 皮肤包系统已移除 —— 多套皮肤各自一套配色策略, 组件层很难做到处处一致; 强调色只换 4 个 token,
// 组件一律走 token, 不会出现这种问题。
import { create } from "zustand";
import { ACCENT_PRESETS, DEFAULT_ACCENT, accentCss, accentHex, normalizeHex } from "../lib/accent";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const MODE_KEY = "kitsune.themeMode";
// 强调色: 预设 id 或 #rrggbb; 自定义色另存一份, 切回预设再点「自定义」时调色盘还停在上次的颜色
const ACCENT_KEY = "kitsune.accent";
const ACCENT_CUSTOM_KEY = "kitsune.accentCustom";
const ACCENT_STYLE_ID = "accent-tokens";
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

function readAccent(): string {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    if (v && (ACCENT_PRESETS.some((p) => p.id === v) || normalizeHex(v))) return normalizeHex(v) ?? v;
  } catch {
    // 回落默认
  }
  return DEFAULT_ACCENT;
}

function readCustomAccent(fallback: string): string {
  try {
    const v = normalizeHex(localStorage.getItem(ACCENT_CUSTOM_KEY) ?? "");
    if (v) return v;
  } catch {
    // 回落
  }
  return accentHex(fallback) ?? "#ff7400";
}

/**
 * 写强调色 token: 注入 / 更新 <style id="accent-tokens">。墨 → 移除, 用回 index.css 原值。
 * 每次都 append 到 head 末尾: 选择器与 index.css 同权重, 靠「后出现」取胜 ——
 * 开发态 Vite 会往 head 里追加样式, 保持自己在最后才稳。
 * 桌宠窗口与主窗口共用 bundle, 两边启动时都调一次 (main.tsx)
 */
export function applyAccent(choice: string) {
  if (typeof document === "undefined") return;
  const css = accentCss(choice);
  let el = document.getElementById(ACCENT_STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = ACCENT_STYLE_ID;
  }
  if (el.textContent !== css) el.textContent = css;
  document.head.appendChild(el);
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
  /** 强调色选择: 预设 id (见 ACCENT_PRESETS) 或 #rrggbb 自定义色 */
  accent: string;
  /** 最近一次的自定义色 (调色盘初值) */
  customAccent: string;
  init: () => void;
  setMode: (mode: ThemeMode) => void;
  setAccent: (choice: string) => void;
}

let initialized = false;

export const useThemeStore = create<ThemeStore>((set, get) => {
  const mode = readMode();
  const accent = readAccent();
  return {
    mode,
    resolved: resolve(mode),
    accent,
    customAccent: readCustomAccent(accent),

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
      applyAccent(get().accent);
      media()?.addEventListener("change", () => {
        if (get().mode !== "system") return;
        const r = resolve("system");
        apply(r, true);
        set({ resolved: r });
      });
    },

    /** 先写 token 再 set: 订阅者 (桌宠桥) 收到通知时读 computed style 已是新色 */
    setAccent: (choice) => {
      const hex = normalizeHex(choice);
      const next = hex ?? (ACCENT_PRESETS.some((p) => p.id === choice) ? choice : DEFAULT_ACCENT);
      applyAccent(next);
      set(hex ? { accent: next, customAccent: hex } : { accent: next });
      try {
        localStorage.setItem(ACCENT_KEY, next);
        if (hex) localStorage.setItem(ACCENT_CUSTOM_KEY, hex);
      } catch {
        // 忽略
      }
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
