// 主题皮肤 store: 皮肤列表 + 当前主题 (只有纯色主题, 壁纸舞台已删除)
// 切换主题 = 写 :root CSS 变量 + data-theme/data-base 属性 + override.css 注入
// 契约对齐 Rust skins.rs (serde 序列化, snake_case 字段) + design.md 皮肤包 schema
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/** Rust 侧 SkinMeta */
export interface SkinMeta {
  id: string;
  name: string;
  author: string;
  version: string;
  base: "light" | "dark";
  colors: Record<string, string>;
  has_override: boolean;
}

// localStorage 键: 与现有 kitsune.projectOrder 同前缀, 不冲突
const ACTIVE_SKIN_KEY = "kitsune.activeSkin";
// 已作废的旧键, 启动时清理: 气泡三件套与三个不透明率/模糊滑杆 (D2), 壁纸舞台的暗幕浓度
const LEGACY_KEYS = [
  "kitsune.bubbleEnabled",
  "kitsune.bubbleOpacity",
  "kitsune.bubbleColor",
  "kitsune.bubblePrefs",
  "kitsune.chatOpacity",
  "kitsune.sidebarOpacity",
  "kitsune.bgBlur",
  "kitsune.scrim",
];

// StrictMode 双跑 effect 防重入: init 只执行一次
let initialized = false;

// 与 main.tsx 首帧预设的 data-base="light" 一致; 保存的 id 不存在 (含改名前的旧 id) 时也回落到这里
export const DEFAULT_SKIN_ID = "white";

/** 根容器 (App.tsx #app-root): 切换过渡挂这里 */
function rootEl(): HTMLElement | null {
  return document.getElementById("app-root");
}

/** override.css 注入标签: 全局唯一, 切皮肤时整体替换 (第三方皮肤兼容机制保留) */
function overrideStyleEl(): HTMLStyleElement {
  let el = document.getElementById("skin-override-style") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "skin-override-style";
    document.head.appendChild(el);
  }
  return el;
}

/** 上一个皮肤写过的变量名: 切换时先清掉, 防残留变量跨皮肤串扰 */
let lastColorKeys: string[] = [];

interface ThemeStore {
  skins: SkinMeta[];
  activeSkinId: string;
  /** 当前皮肤 base 方向: 驱动 Shiki 主题 + markdown 文字色 (Markdown.tsx 订阅) */
  activeBase: "light" | "dark";
  init: () => Promise<void>;
  applyTheme: (skin: SkinMeta) => Promise<void>;
  reloadSkins: () => Promise<void>;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  skins: [],
  activeSkinId: DEFAULT_SKIN_ID,
  activeBase: "light",

  /** 启动: 清理废弃偏好 → 拉皮肤列表 → 恢复持久化 → 应用当前主题 */
  init: async () => {
    if (initialized) return;
    initialized = true;
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    const skins = await invoke<SkinMeta[]>("list_skins");
    const saved = localStorage.getItem(ACTIVE_SKIN_KEY) ?? DEFAULT_SKIN_ID;
    const skin =
      skins.find((s) => s.id === saved) ??
      skins.find((s) => s.id === DEFAULT_SKIN_ID) ??
      skins[0];
    if (!skin) return; // 理论不可能: 内置至少一套
    set({ skins });
    await get().applyTheme(skin);
  },

  applyTheme: async (skin) => {
    const el = document.documentElement;
    el.dataset.theme = skin.id;
    el.dataset.base = skin.base;

    // 1. 清掉旧皮肤定义过的变量再写新的 (primary 色阶 / accent / pane 等)
    for (const k of lastColorKeys) el.style.removeProperty(`--${k}`);
    lastColorKeys = Object.keys(skin.colors ?? {});
    for (const [k, v] of Object.entries(skin.colors ?? {})) {
      el.style.setProperty(`--${k}`, v);
    }

    // 2. override.css: 有则注入 (选择器建议带 [data-theme] 前缀防串扰), 无则移除
    if (skin.has_override) {
      const css = await invoke<string>("get_skin_asset", { skinId: skin.id, assetName: "override" });
      overrideStyleEl().textContent = css;
    } else {
      overrideStyleEl().textContent = "";
    }

    // 3. 状态 + 持久化
    set({ activeSkinId: skin.id, activeBase: skin.base });
    localStorage.setItem(ACTIVE_SKIN_KEY, skin.id);

    // 4. 淡入淡出过渡 ~220ms (底色切换瞬间)
    rootEl()?.animate([{ opacity: 0.55 }, { opacity: 1 }], {
      duration: 220,
      easing: "ease-out",
    });
  },

  /** 放新皮肤后手动刷新列表 (不切换当前主题) */
  reloadSkins: async () => {
    const skins = await invoke<SkinMeta[]>("list_skins");
    set({ skins });
  },
}));
