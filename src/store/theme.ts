// 主题皮肤 store: 皮肤列表 + 当前主题 + 容器不透明率 + 气泡框开关
// 切换主题 = 写 :root CSS 变量 + data-theme/data-base 属性 + 背景图 + override.css 注入
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
  has_bg: boolean;
  has_override: boolean;
  preview_data_uri?: string;
  /** 皮肤推荐的气泡框开关: 用户从未手动改过时生效 */
  bubble?: boolean;
}

// localStorage 键: 与现有 kitsune.projectOrder 同前缀, 不冲突
const ACTIVE_SKIN_KEY = "kitsune.activeSkin";
const CHAT_OPACITY_KEY = "kitsune.chatOpacity";
const SIDEBAR_OPACITY_KEY = "kitsune.sidebarOpacity";
const BUBBLE_ENABLED_KEY = "kitsune.bubbleEnabled";
const BUBBLE_OPACITY_KEY = "kitsune.bubbleOpacity";
const BG_BLUR_KEY = "kitsune.bgBlur";

// StrictMode 双跑 effect 防重入: init 只执行一次
let initialized = false;

export const DEFAULT_SKIN_ID = "light-sky";
const DEFAULT_CHAT_OPACITY = 0.75;
const DEFAULT_SIDEBAR_OPACITY = 0.6;
const DEFAULT_BUBBLE_OPACITY = 0.55;
const DEFAULT_BG_BLUR = 10;

function readNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 根容器 (App.tsx 根 div id="app-root"): 背景图 + 切换过渡挂这里 */
function rootEl(): HTMLElement | null {
  return document.getElementById("app-root");
}

/** override.css 注入标签: 全局唯一, 切皮肤时整体替换 */
function overrideStyleEl(): HTMLStyleElement {
  let el = document.getElementById("skin-override-style") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "skin-override-style";
    document.head.appendChild(el);
  }
  return el;
}

/** 背景图 data URI 内存缓存: 切回同皮肤不重复读盘 */
const bgCache = new Map<string, string>();
async function getBgDataUri(skinId: string): Promise<string> {
  const hit = bgCache.get(skinId);
  if (hit) return hit;
  const uri = await invoke<string>("get_skin_asset", { skinId, assetName: "bg" });
  bgCache.set(skinId, uri);
  return uri;
}

/** 上一个皮肤写过的变量名: 切换时先清掉, 防残留变量跨皮肤串扰 */
let lastColorKeys: string[] = [];

interface ThemeStore {
  skins: SkinMeta[];
  activeSkinId: string;
  /** 当前皮肤 base 方向: 驱动 Shiki 主题 + markdown 文字色 (Markdown.tsx 订阅) */
  activeBase: "light" | "dark";
  chatOpacity: number;     // 0.4–0.95, 会话区
  sidebarOpacity: number;  // 0.2–0.9, 侧边栏
  bubbleEnabled: boolean;  // 消息气泡框开关
  bubbleOpacity: number;   // 0.3–0.9, 气泡
  bgBlur: number;          // 0–30px, 背景层模糊度 (有背景图的皮肤生效)
  init: () => Promise<void>;
  applyTheme: (skin: SkinMeta) => Promise<void>;
  setChatOpacity: (n: number) => void;
  setSidebarOpacity: (n: number) => void;
  setBubbleEnabled: (on: boolean) => void;
  setBubbleOpacity: (n: number) => void;
  setBgBlur: (n: number) => void;
  reloadSkins: () => Promise<void>;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  skins: [],
  activeSkinId: DEFAULT_SKIN_ID,
  activeBase: "light",
  chatOpacity: DEFAULT_CHAT_OPACITY,
  sidebarOpacity: DEFAULT_SIDEBAR_OPACITY,
  bubbleEnabled: false,
  bubbleOpacity: DEFAULT_BUBBLE_OPACITY,
  bgBlur: DEFAULT_BG_BLUR,

  /** 启动: 拉皮肤列表 + 恢复持久化 (主题/不透明率/气泡) + 应用当前主题 */
  init: async () => {
    if (initialized) return;
    initialized = true;
    const skins = await invoke<SkinMeta[]>("list_skins");
    const saved = localStorage.getItem(ACTIVE_SKIN_KEY) ?? DEFAULT_SKIN_ID;
    const skin =
      skins.find((s) => s.id === saved) ??
      skins.find((s) => s.id === DEFAULT_SKIN_ID) ??
      skins[0];
    if (!skin) return; // 理论不可能: 内置至少一套
    const chatOpacity = readNumber(CHAT_OPACITY_KEY, DEFAULT_CHAT_OPACITY);
    const sidebarOpacity = readNumber(SIDEBAR_OPACITY_KEY, DEFAULT_SIDEBAR_OPACITY);
    const bubbleOpacity = readNumber(BUBBLE_OPACITY_KEY, DEFAULT_BUBBLE_OPACITY);
    const bgBlur = readNumber(BG_BLUR_KEY, DEFAULT_BG_BLUR);
    // 气泡开关: 无持久化记录 → 跟随皮肤推荐; 用户改过 → 以用户为准
    const rawBubble = localStorage.getItem(BUBBLE_ENABLED_KEY);
    const bubbleEnabled = rawBubble === null ? (skin.bubble ?? false) : rawBubble === "1";
    set({
      skins,
      activeSkinId: skin.id,
      activeBase: skin.base,
      chatOpacity,
      sidebarOpacity,
      bubbleEnabled,
      bubbleOpacity,
      bgBlur,
    });
    applyOpacityVars(chatOpacity, sidebarOpacity, bubbleOpacity);
    document.documentElement.style.setProperty("--bg-blur", `${bgBlur}px`);
    await get().applyTheme(skin);
  },

  applyTheme: async (skin) => {
    const el = document.documentElement;
    el.dataset.theme = skin.id;
    el.dataset.base = skin.base;

    // 1. 清掉旧皮肤定义过的变量再写新的 (primary 色阶 / accent / bubble-bg 等)
    for (const k of lastColorKeys) el.style.removeProperty(`--${k}`);
    lastColorKeys = Object.keys(skin.colors ?? {});
    for (const [k, v] of Object.entries(skin.colors ?? {})) {
      el.style.setProperty(`--${k}`, v);
    }

    // 2. 背景图: 有则写 --bg-image 变量到 :root (背景层是 app-root 兄弟节点, 变量须全局可见),
    //    无则置 none (light 透出根容器渐变, dark 由 [data-base] 覆盖渐变)
    if (skin.has_bg) {
      const uri = await getBgDataUri(skin.id);
      document.documentElement.style.setProperty("--bg-image", `url("${uri}")`);
    } else {
      document.documentElement.style.setProperty("--bg-image", "none");
    }

    // 3. override.css: 有则注入 (选择器建议带 [data-theme] 前缀防串扰), 无则移除
    if (skin.has_override) {
      const css = await invoke<string>("get_skin_asset", { skinId: skin.id, assetName: "override" });
      overrideStyleEl().textContent = css;
    } else {
      overrideStyleEl().textContent = "";
    }

    // 4. 状态 + 持久化
    set({ activeSkinId: skin.id, activeBase: skin.base });
    localStorage.setItem(ACTIVE_SKIN_KEY, skin.id);

    // 5. 淡入淡出过渡 ~220ms (底色/背景图切换瞬间)
    rootEl()?.animate([{ opacity: 0.55 }, { opacity: 1 }], {
      duration: 220,
      easing: "ease-out",
    });
  },

  setChatOpacity: (n) => {
    set({ chatOpacity: n });
    document.documentElement.style.setProperty("--chat-opacity", String(n));
    try {
      localStorage.setItem(CHAT_OPACITY_KEY, String(n));
    } catch {
      /* ignore */
    }
  },

  setSidebarOpacity: (n) => {
    set({ sidebarOpacity: n });
    document.documentElement.style.setProperty("--sidebar-opacity", String(n));
    try {
      localStorage.setItem(SIDEBAR_OPACITY_KEY, String(n));
    } catch {
      /* ignore */
    }
  },

  setBubbleEnabled: (on) => {
    set({ bubbleEnabled: on });
    try {
      localStorage.setItem(BUBBLE_ENABLED_KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
  },

  setBubbleOpacity: (n) => {
    set({ bubbleOpacity: n });
    document.documentElement.style.setProperty("--bubble-opacity", String(n));
    try {
      localStorage.setItem(BUBBLE_OPACITY_KEY, String(n));
    } catch {
      /* ignore */
    }
  },

  /** 放新皮肤后手动刷新列表 (不切换当前主题) */
  reloadSkins: async () => {
    const skins = await invoke<SkinMeta[]>("list_skins");
    set({ skins });
  },

  setBgBlur: (n) => {
    set({ bgBlur: n });
    document.documentElement.style.setProperty("--bg-blur", `${n}px`);
    try {
      localStorage.setItem(BG_BLUR_KEY, String(n));
    } catch {
      /* ignore */
    }
  },
}));

function applyOpacityVars(chat: number, sidebar: number, bubble: number) {
  const el = document.documentElement;
  el.style.setProperty("--chat-opacity", String(chat));
  el.style.setProperty("--sidebar-opacity", String(sidebar));
  el.style.setProperty("--bubble-opacity", String(bubble));
}
