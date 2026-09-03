// 主题皮肤 store: 皮肤列表 + 当前主题 + 容器不透明率 + 气泡框开关 + 气泡颜色
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

/** 单皮肤的气泡偏好: 字段全可选 — 只有用户实际调过的项才落盘, 其余走皮肤推荐值 */
interface BubblePref {
  enabled?: boolean;
  color?: string | null; // hex, null = 用户显式选择"跟随皮肤" (与字段缺失语义不同, 都保留)
  opacity?: number;
}

// localStorage 键: 与现有 kitsune.projectOrder 同前缀, 不冲突
const ACTIVE_SKIN_KEY = "kitsune.activeSkin";
const CHAT_OPACITY_KEY = "kitsune.chatOpacity";
const SIDEBAR_OPACITY_KEY = "kitsune.sidebarOpacity";
// ↓ 三个全局气泡键已废弃 (跨皮肤串味): 气泡偏好改存 BUBBLE_PREFS_KEY 按皮肤分桶, 它们仅供旧数据迁移
const BUBBLE_ENABLED_KEY = "kitsune.bubbleEnabled";
const BUBBLE_OPACITY_KEY = "kitsune.bubbleOpacity";
const BUBBLE_COLOR_KEY = "kitsune.bubbleColor"; // 气泡自定义底色 (hex), 空 = 跟随皮肤
const BG_BLUR_KEY = "kitsune.bgBlur";
// 单键 map 存储: 皮肤可扩展 (第三方皮肤包), 拼键方案会让 localStorage 键数无上限且没法整体解析兜底
const BUBBLE_PREFS_KEY = "kitsune.bubblePrefs";

// StrictMode 双跑 effect 防重入: init 只执行一次
let initialized = false;

export const DEFAULT_SKIN_ID = "flame";
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
/** applyTheme 按 has_bg 写入的 surface/alpha 变量 (不在 skin.colors 里, 单独跟踪清理) */
let lastAppliedVars: string[] = [];

interface ThemeStore {
  skins: SkinMeta[];
  activeSkinId: string;
  /** 当前皮肤 base 方向: 驱动 Shiki 主题 + markdown 文字色 (Markdown.tsx 订阅) */
  activeBase: "light" | "dark";
  chatOpacity: number;     // 0.4–0.95, 会话区
  sidebarOpacity: number;  // 0.2–0.9, 侧边栏
  bubbleEnabled: boolean;  // 消息气泡框开关
  bubbleOpacity: number;   // 0–1, 气泡不透明率 (不设上下限, 用户自由调)
  bubbleColor: string | null; // 气泡自定义底色 (hex), null = 跟随皮肤 --bubble-bg
  bgBlur: number;          // 0–30px, 背景层模糊度 (有背景图的皮肤生效)
  init: () => Promise<void>;
  applyTheme: (skin: SkinMeta) => Promise<void>;
  setChatOpacity: (n: number) => void;
  setSidebarOpacity: (n: number) => void;
  setBubbleEnabled: (on: boolean) => void;
  setBubbleOpacity: (n: number) => void;
  setBubbleColor: (hex: string | null) => void;
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
  bubbleColor: null,
  bgBlur: DEFAULT_BG_BLUR,

  /** 启动: 拉皮肤列表 + 恢复持久化 (主题/不透明率) + 应用当前主题 (含按皮肤重解析气泡偏好) */
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
    // 旧版全局气泡键一次性迁移到当前皮肤: 必须在 applyTheme 读 prefs 之前完成
    migrateLegacyBubbleKeys();
    const chatOpacity = readNumber(CHAT_OPACITY_KEY, DEFAULT_CHAT_OPACITY);
    const sidebarOpacity = readNumber(SIDEBAR_OPACITY_KEY, DEFAULT_SIDEBAR_OPACITY);
    const bgBlur = readNumber(BG_BLUR_KEY, DEFAULT_BG_BLUR);
    set({
      skins,
      activeSkinId: skin.id,
      activeBase: skin.base,
      chatOpacity,
      sidebarOpacity,
      bgBlur,
    });
    applyOpacityVars(chatOpacity, sidebarOpacity);
    document.documentElement.style.setProperty("--bg-blur", `${bgBlur}px`);
    // 气泡三项不在这里读 — 交给末尾的 applyTheme 按当前皮肤重解析, 单一入口不留第二条读取路径
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

    // 1.5 表面层次体系: 按 has_bg 收敛分支, 组件只认 --surface-* / --*-alpha 一套变量。
    //    先清上次 applyTheme 写入的 surface/alpha 变量, 防跨皮肤串扰 (这些不在 skin.colors 里)。
    // lastAppliedVars 存的是带 -- 前缀的完整变量名 (与 lastColorKeys 不同), 直接移除不再拼前缀
    for (const k of lastAppliedVars) el.style.removeProperty(k);
    const appliedVars: string[] = [];
    const setSurfaceVar = (name: string, value: string) => {
      el.style.setProperty(name, value);
      appliedVars.push(name);
    };
    if (skin.has_bg) {
      // 背景图皮肤: surface 三件套转发到旧变量 — 皮肤 colors 若定义了 surface/sidebar-surface/panel,
      // 上面的循环已写进 inline style, var() 自然取到皮肤值; 未定义则回落 index.css 里随 base 方向
      // 变化的默认值 (如暗色 --surface: 10 5 20)。不能硬编码回落白色, 否则暗色背景图皮肤会被刷白。
      // alpha 引用滑块变量 — 滑块继续写 --*-opacity 即可实时联动, 无需改滑块逻辑
      setSurfaceVar("--surface-sunken", "var(--sidebar-surface)");
      setSurfaceVar("--surface-base", "var(--surface)");
      setSurfaceVar("--surface-raised", "var(--panel)");
      setSurfaceVar("--chat-alpha", "var(--chat-opacity)");
      setSurfaceVar("--sidebar-alpha", "var(--sidebar-opacity)");
      setSurfaceVar("--raised-alpha", "0.8");
      // 内容流里的小面板 (工具卡片/user 轻气泡) 降为半透明: 实色块会糊掉背景图, 破坏毛玻璃观感
      setSurfaceVar("--overlay-alpha", "0.35");
      setSurfaceVar("--code-alpha", "0.75");
    } else {
      // 纯色皮肤: surface 三件套走 index.css 默认值 (皮肤 colors 自带 surface-* 则上面循环已覆盖),
      // 三个 alpha 全置 1 — 半透明在无背景图下是视觉空操作, 实色靠表面色阶差撑层次
      setSurfaceVar("--chat-alpha", "1");
      setSurfaceVar("--sidebar-alpha", "1");
      setSurfaceVar("--raised-alpha", "1");
      setSurfaceVar("--overlay-alpha", "1");
      setSurfaceVar("--code-alpha", "1");
    }
    lastAppliedVars = appliedVars;

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

    // 5. 气泡偏好按新皮肤重解析: 每个皮肤各记一套, 无记录的项回落该皮肤推荐值。
    //    在 set({ activeSkinId }) 之后执行, 保证 writeBubblePref 等路径拿到的 activeSkinId 一致
    const { enabled, color, opacity } = resolveBubblePref(skin, readBubblePrefs());
    set({ bubbleEnabled: enabled, bubbleColor: color, bubbleOpacity: opacity });
    el.style.setProperty("--bubble-opacity", String(opacity));
    // --bubble-bg 三态回落 (与 setBubbleColor 的 null 分支同一语义):
    // 不能什么都不做 — 自定义色是 setter 直接 inline 在 :root 上的, 从未进过 lastColorKeys,
    // 浅色纯色皮肤的 colors 又不含 bubble-bg (如 light-sky), 第 1 步清理覆盖不到它,
    // 不处理的话上个皮肤的自定义深色会残留到本皮肤 (深底白字事故的根源);
    // 也不能一律移除 — 第 1 步刚把皮肤自带的 bubble-bg inline 写入, 裸删会把它误删,
    // 底色回落到 index.css 的 base 方向默认值后, 与 updateBubbleTextColor 按皮肤原值
    // 判出的文字色方向相反 (深底深字), 可读性直接崩掉
    if (color) {
      el.style.setProperty("--bubble-bg", color);
    } else {
      const skinBg = skin.colors?.["bubble-bg"];
      if (skinBg) el.style.setProperty("--bubble-bg", skinBg);
      else el.style.removeProperty("--bubble-bg");
    }
    // 气泡内文字色随底色亮度联动: 深底配浅字 / 浅底配深字 (含 markdown 标题, 见 index.css)
    updateBubbleTextColor(color, skin);

    // 6. 淡入淡出过渡 ~220ms (底色/背景图切换瞬间)
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
    writeBubblePref(get().activeSkinId, { enabled: on });
  },

  setBubbleColor: (hex) => {
    set({ bubbleColor: hex });
    // null 也落盘而非删字段: 保留"用户显式选了跟随皮肤"的语义, 与从未调过 (字段缺失) 区分
    writeBubblePref(get().activeSkinId, { color: hex });
    // 写 CSS: 自定义色覆盖 --bubble-bg; 重置(null)则恢复当前皮肤的 bubble-bg
    const el = document.documentElement;
    const { skins, activeSkinId } = get();
    const skin = skins.find((s) => s.id === activeSkinId);
    // color-mix 原生支持 hex 输入, 无需转通道格式
    if (hex) {
      el.style.setProperty("--bubble-bg", hex);
    } else {
      const bg = skin?.colors?.["bubble-bg"];
      if (bg) el.style.setProperty("--bubble-bg", bg);
      else el.style.removeProperty("--bubble-bg");
    }
    // 联动文字色: 深底配浅字 / 浅底配深字
    updateBubbleTextColor(hex, skin);
  },

  setBubbleOpacity: (n) => {
    set({ bubbleOpacity: n });
    document.documentElement.style.setProperty("--bubble-opacity", String(n));
    writeBubblePref(get().activeSkinId, { opacity: n });
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

function applyOpacityVars(chat: number, sidebar: number) {
  const el = document.documentElement;
  el.style.setProperty("--chat-opacity", String(chat));
  el.style.setProperty("--sidebar-opacity", String(sidebar));
}

/** 读全量气泡 prefs: JSON 坏了 / 不是对象 / 是数组一律当空 map, 绝不让启动路径抛异常 */
function readBubblePrefs(): Record<string, BubblePref> {
  try {
    const raw = localStorage.getItem(BUBBLE_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, BubblePref>;
  } catch {
    return {};
  }
}

/** 取某皮肤的生效气泡值: 用户调过的项用用户值, 没调过的回落该皮肤推荐值 (skin.bubble / 默认不透明率) */
function resolveBubblePref(skin: SkinMeta, prefs: Record<string, BubblePref>) {
  const pref = prefs[skin.id] ?? {};
  return {
    enabled: pref.enabled ?? (skin.bubble ?? false),
    color: pref.color ?? null,
    opacity: pref.opacity ?? DEFAULT_BUBBLE_OPACITY,
  };
}

/** 写当前皮肤的一项气泡偏好: 单键 map 只能读-改-写整体, 失败静默同其他 setter */
function writeBubblePref(skinId: string, patch: Partial<BubblePref>) {
  try {
    const prefs = readBubblePrefs();
    prefs[skinId] = { ...prefs[skinId], ...patch };
    localStorage.setItem(BUBBLE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/** 旧版全局气泡键 → 当时激活皮肤的一次性迁移: 老用户的设置留在原皮肤上, 其余皮肤保持干净。
    幂等: 旧键删掉后下次启动不再命中; 新结构里已有目标皮肤记录时不覆盖 (不能抹掉新版下的设置) */
function migrateLegacyBubbleKeys() {
  if (
    localStorage.getItem(BUBBLE_ENABLED_KEY) === null &&
    localStorage.getItem(BUBBLE_OPACITY_KEY) === null &&
    localStorage.getItem(BUBBLE_COLOR_KEY) === null
  ) {
    return;
  }
  const targetSkinId = localStorage.getItem(ACTIVE_SKIN_KEY) ?? DEFAULT_SKIN_ID;
  const pref: BubblePref = {};
  const rawEnabled = localStorage.getItem(BUBBLE_ENABLED_KEY);
  if (rawEnabled !== null) pref.enabled = rawEnabled === "1";
  const rawColor = localStorage.getItem(BUBBLE_COLOR_KEY);
  if (rawColor !== null) pref.color = rawColor;
  // 注意 Number(null) === 0 会误过 Number.isFinite 校验, 必须先判字符串存在
  const rawOpacityStr = localStorage.getItem(BUBBLE_OPACITY_KEY);
  if (rawOpacityStr !== null) {
    const n = Number(rawOpacityStr);
    if (Number.isFinite(n)) pref.opacity = n;
  }
  const prefs = readBubblePrefs();
  prefs[targetSkinId] = { ...pref, ...prefs[targetSkinId] };
  try {
    localStorage.setItem(BUBBLE_PREFS_KEY, JSON.stringify(prefs));
    // 写成功才删旧键: setItem 万一失败, 下次启动还能再迁, 不丢用户数据
    localStorage.removeItem(BUBBLE_ENABLED_KEY);
    localStorage.removeItem(BUBBLE_OPACITY_KEY);
    localStorage.removeItem(BUBBLE_COLOR_KEY);
  } catch {
    /* ignore */
  }
}

/** 取当前实际生效的气泡底色 CSS 颜色值: 用户自定义色 > 皮肤 colors > index.css 按 base 方向的默认值。
   最后一档必须跟着 base 走 — 皮肤不定义 bubble-bg 时, CSS 里真正生效的是 [data-base="dark"] 的
   深紫黑 (暗) 或 :root 的白 (亮); 一律当白色会让暗色皮肤判成浅底配深字, 深底深字读不了。
   回落值与 index.css 的 --bubble-bg 默认值绑定 (oklch 字面量, 改那边要同步);
   皮肤 colors 现在可能是任意 CSS 颜色格式 (oklch/hex/rgb), 直接透传给 CSS 解析 */
function resolveBubbleBg(bubbleColor: string | null, skin: SkinMeta | undefined): string {
  if (bubbleColor) return bubbleColor;
  return skin?.colors?.["bubble-bg"] ?? (skin?.base === "dark" ? "oklch(13.423% 0.0349 299)" : "oklch(100% 0 0)");
}

/** 气泡内文字色随底色亮度联动: 深底配浅字, 浅底配深字。
   底色统一喂给 CSS color-mix 换算出 L 通道 (感知亮度, 比 Rec.601 更准):
   L 阈值取 0.62 — Rec.601 旧阈值 145/255 ≈ 0.62, 以全部内置皮肤 + 典型自定义色实测校准 */
function updateBubbleTextColor(bubbleColor: string | null, skin: SkinMeta | undefined) {
  const bg = resolveBubbleBg(bubbleColor, skin);
  const probe = document.createElement("div");
  probe.style.color = `oklch(from ${bg} l c h)`;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  // 相对色彩语法解析失败 (异常值兜底): 保持深字 — 内置皮肤底色以浅底为主
  const m = computed.match(/oklch\(([\d.]+)/);
  const l = m ? parseFloat(m[1]) : 1;
  document.documentElement.style.setProperty(
    "--text-on-bubble",
    l >= 0.62 ? "oklch(26.862% 0 0)" : "oklch(95.869% 0 0)",
  );
}
