// 主题皮肤 store: 皮肤列表 + 当前主题 + 风格派生 (工坊/舞台) + 暗幕浓度
// 切换主题 = 写 :root CSS 变量 + data-theme/data-base/data-style 属性 + 背景图 + override.css 注入
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
}

// localStorage 键: 与现有 kitsune.projectOrder 同前缀, 不冲突
const ACTIVE_SKIN_KEY = "kitsune.activeSkin";
const SCRIM_KEY = "kitsune.scrim";
// D2: 气泡三件套与三个不透明率/模糊滑杆的旧键已作废, 启动时清理, 不让旧欲望留在本机
const LEGACY_KEYS = [
  "kitsune.bubbleEnabled",
  "kitsune.bubbleOpacity",
  "kitsune.bubbleColor",
  "kitsune.bubblePrefs",
  "kitsune.chatOpacity",
  "kitsune.sidebarOpacity",
  "kitsune.bgBlur",
];

// StrictMode 双跑 effect 防重入: init 只执行一次
let initialized = false;

export const DEFAULT_SKIN_ID = "flame";
/** 暗幕浓度 (0.5–0.95), 仅壁纸舞台生效 */
const DEFAULT_SCRIM = 0.8;

function readNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

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

/** 暗幕浓度同时驱动 --scrim (CSS 消费) 与 store (滑杆显示) */
function applyScrimVar(n: number) {
  document.documentElement.style.setProperty("--scrim", String(n));
}

interface ThemeStore {
  skins: SkinMeta[];
  activeSkinId: string;
  /** 当前皮肤 base 方向: 驱动 Shiki 主题 + markdown 文字色 (Markdown.tsx 订阅) */
  activeBase: "light" | "dark";
  /** 当前皮肤是否为壁纸皮肤 (= data-style stage): 组件据此分支, 不在组件里判断 has_bg */
  activeHasBg: boolean;
  /** 暗幕浓度 0.5–0.95, 仅壁纸舞台生效 */
  scrim: number;
  init: () => Promise<void>;
  applyTheme: (skin: SkinMeta) => Promise<void>;
  setScrim: (n: number) => void;
  reloadSkins: () => Promise<void>;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  skins: [],
  activeSkinId: DEFAULT_SKIN_ID,
  activeBase: "light",
  activeHasBg: false,
  scrim: DEFAULT_SCRIM,

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
    const scrim = readNumber(SCRIM_KEY, DEFAULT_SCRIM);
    set({ skins, scrim });
    applyScrimVar(scrim);
    await get().applyTheme(skin);
  },

  applyTheme: async (skin) => {
    const el = document.documentElement;
    el.dataset.theme = skin.id;
    el.dataset.base = skin.base;
    // 风格由 has_bg 派生 (D1): 壁纸 → 舞台, 纯色 → 工坊; 不给独立开关
    el.dataset.style = skin.has_bg ? "stage" : "atelier";

    // 1. 清掉旧皮肤定义过的变量再写新的 (primary 色阶 / accent / pane 等)
    for (const k of lastColorKeys) el.style.removeProperty(`--${k}`);
    lastColorKeys = Object.keys(skin.colors ?? {});
    for (const [k, v] of Object.entries(skin.colors ?? {})) {
      el.style.setProperty(`--${k}`, v);
    }

    // 2. 背景图: 有则写 --bg-image (舞台层消费), 无则置 none
    if (skin.has_bg) {
      const uri = await getBgDataUri(skin.id);
      el.style.setProperty("--bg-image", `url("${uri}")`);
    } else {
      el.style.setProperty("--bg-image", "none");
    }

    // 3. override.css: 有则注入 (选择器建议带 [data-theme] 前缀防串扰), 无则移除
    if (skin.has_override) {
      const css = await invoke<string>("get_skin_asset", { skinId: skin.id, assetName: "override" });
      overrideStyleEl().textContent = css;
    } else {
      overrideStyleEl().textContent = "";
    }

    // 4. 状态 + 持久化
    set({ activeSkinId: skin.id, activeBase: skin.base, activeHasBg: skin.has_bg });
    localStorage.setItem(ACTIVE_SKIN_KEY, skin.id);

    // 5. 淡入淡出过渡 ~220ms (底色/背景图切换瞬间)
    rootEl()?.animate([{ opacity: 0.55 }, { opacity: 1 }], {
      duration: 220,
      easing: "ease-out",
    });
  },

  setScrim: (n) => {
    set({ scrim: n });
    applyScrimVar(n);
    try {
      localStorage.setItem(SCRIM_KEY, String(n));
    } catch {
      /* ignore */
    }
  },

  /** 放新皮肤后手动刷新列表 (不切换当前主题) */
  reloadSkins: async () => {
    const skins = await invoke<SkinMeta[]>("list_skins");
    set({ skins });
  },
}));
