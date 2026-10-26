// 桌宠 store (主窗口侧): 配置真值 + 宠物列表 + 事件桥的生命周期
// 契约对齐 Rust pets.rs (serde 序列化, snake_case 字段)
//
// 桌宠窗口是纯受控端, 配置只在这里落 localStorage —— 两个窗口同源共享 localStorage,
// 双写同一个键会有竞态, 所以桌宠侧的变更一律 emit 回来由这里统一写 (applyPatch)。
// 会话信号与事件监听在 src/pet/bridge.ts, 只在开启桌宠时动态加载, 关着时一个监听都不挂。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { canvasSize, windowPosFromFoot, type FootPos } from "../pet/canvas";

/** Rust 侧 PetAction: 一个动作 = 一张图上的一行帧 (v2 横条图恒为第 0 行, v1 图集为行号) */
export interface PetAction {
  /** "类别.变体", 如 work.typing */
  name: string;
  category: string;
  /** 素材键 (包内相对路径), 交给 get_pet_asset */
  image: string;
  row: number;
  /** 逐帧毫秒, 长度即帧数 */
  durations: number[];
  weight: number;
  /** 最少 / 最多播几轮; null 由大脑按类别兜底 */
  loops: [number, number] | null;
  interruptible: boolean;
  /** 仅 walk: 逻辑像素/秒 */
  speed: number | null;
  /** 仅 walk: 素材朝向 */
  facing: "left" | "right" | null;
}

export type PetTier = "required" | "basic" | "full";

/** Rust 侧 PetMeta (v2 规整后的统一形态; 旧 Codex 包在加载时适配成同样的结构) */
export interface PetMeta {
  id: string;
  name: string;
  description: string;
  renderer: "frames";
  frame_width: number;
  frame_height: number;
  personality: "default" | "diligent" | "lazy" | "playful";
  /** 按类别 / 事件分组的台词 */
  lines: Record<string, string[]>;
  actions: PetAction[];
  tier: PetTier;
  /** 缺失的已知类别 (不含 idle) */
  missing: string[];
  source: "v2" | "codex";
}

// localStorage 键: 与现有 kitsune.* 同前缀
const ENABLED_KEY = "kitsune.petEnabled";
const PET_ID_KEY = "kitsune.petId";
const ZOOM_KEY = "kitsune.petZoom";
// 重力 / 散步默认开: 只有用户显式关过才存 "0", 没存过的老用户升级后直接是开
const GRAVITY_KEY = "kitsune.petGravity";
const WALK_KEY = "kitsune.petWalk";
const POS_KEY = "kitsune.petPos";

const DEFAULT_ZOOM = 1;

// StrictMode 双跑 effect 防重入
let initialized = false;

interface PetStore {
  enabled: boolean;
  petId: string | null;
  zoom: number;
  gravity: boolean;
  walk: boolean;
  /** 脚底点 (v: 2); 旧版存的窗口左上角没有 v, 开窗时迁移 */
  pos: StoredPos | null;
  pets: PetMeta[];

  init: () => void;
  loadPets: () => Promise<void>;
  /** 桌宠窗口回传的变更 (经事件桥转进来) */
  applyPatch: (p: PetPatch) => void;
  setEnabled: (v: boolean) => Promise<void>;
  setPetId: (id: string) => void;
  setZoom: (z: number) => void;
  setGravity: (v: boolean) => void;
  setWalk: (v: boolean) => void;
}

/** 桌宠窗口 → 主窗口的变更回传 (pet_patch 载荷) */
export interface PetPatch {
  zoom?: number;
  petId?: string;
  pos?: FootPos | null;
  enabled?: boolean;
}

/** 推给桌宠窗口的配置 (桌宠侧 pet_config 监听的载荷) */
export interface PetConfig {
  petId: string | null;
  zoom: number;
  gravity: boolean;
  walk: boolean;
  theme: PetTheme;
}

/** 主窗口提炼的会话事实快照 (pet_signals 载荷)。只描述"发生了什么", 宠物怎么表现由桌宠侧大脑决定 */
export interface PetSignals {
  /** isStreaming 的会话数 */
  running: number;
  /** 完成待看, 按完成先后 (at 升序) */
  pending: { sessionId: string; name: string; at: number }[];
  /** 有 dialog 类 uiRequests 在等用户的会话 */
  waiting: { sessionId: string; name: string }[];
  /** 工具报错计数, 递增即"刚报错" (瞬时事件没法用状态表达) */
  errorSeq: number;
}

/** 桌宠 → 主窗口: 呼出主窗口并切到该会话 (pet_activate 载荷) */
export interface PetActivate {
  sessionId: string;
}

/** 皮肤配色: 皮肤是主窗口往自己的 <html> 上内联写 CSS 变量, 桌宠窗口是另一个页面拿不到,
 *  只能由主窗口把气泡用得到的几个变量读出来一起下发 */
export interface PetTheme {
  base: "light" | "dark";
  vars: Record<string, string>;
}

const THEME_VARS = ["bg", "fg", "fg-2", "line", "line-2", "accent"];

function readTheme(): PetTheme {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const k of THEME_VARS) {
    const v = cs.getPropertyValue(`--${k}`).trim();
    if (v) vars[k] = v;
  }
  return { base: root.dataset.base === "dark" ? "dark" : "light", vars };
}

type StoredPos = { x: number; y: number; v?: number };

function readPos(): StoredPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return typeof p?.x === "number" && typeof p?.y === "number" ? p : null;
  } catch {
    return null;
  }
}

// 事件桥: 开启桌宠时才动态加载并启动, 关闭时释放
let stopBridge: (() => void) | null = null;
let bridgeStarting: Promise<void> | null = null;

async function ensureBridge() {
  if (stopBridge) return;
  // 并发开启只加载一次: 快速连点开关时第二次调用复用第一次的加载
  bridgeStarting ??= import("../pet/bridge")
    .then(async (m) => {
      stopBridge = await m.startBridge();
    })
    .finally(() => {
      bridgeStarting = null;
    });
  await bridgeStarting;
}

function releaseBridge() {
  stopBridge?.();
  stopBridge = null;
}

export const usePetStore = create<PetStore>((set, get) => ({
  enabled: localStorage.getItem(ENABLED_KEY) === "1",
  petId: localStorage.getItem(PET_ID_KEY),
  zoom: Number(localStorage.getItem(ZOOM_KEY)) || DEFAULT_ZOOM,
  gravity: localStorage.getItem(GRAVITY_KEY) !== "0",
  walk: localStorage.getItem(WALK_KEY) !== "0",
  pos: readPos(),
  pets: [],

  init: () => {
    if (initialized) return;
    initialized = true;
    // 必须等宠物列表拉回来再开窗: setEnabled 要从 pets 里挑角色算窗口尺寸,
    // 抢跑会读到空列表直接静默 return, 表现为"上次开着但重启后不出来"
    void (async () => {
      await get().loadPets();
      if (get().enabled) await get().setEnabled(true);
    })();
  },

  applyPatch: (p) => {
    if (typeof p.zoom === "number") {
      localStorage.setItem(ZOOM_KEY, String(p.zoom));
      set({ zoom: p.zoom });
    }
    if (typeof p.petId === "string") {
      localStorage.setItem(PET_ID_KEY, p.petId);
      set({ petId: p.petId });
      pushConfig();
    }
    if (p.pos !== undefined) {
      if (p.pos === null) localStorage.removeItem(POS_KEY);
      else localStorage.setItem(POS_KEY, JSON.stringify(p.pos));
      set({ pos: p.pos });
    }
    if (p.enabled === false) void get().setEnabled(false);
  },

  loadPets: async () => {
    try {
      const pets = await invoke<PetMeta[]>("list_pets");
      set({ pets });
      // 选中的宠物包被删掉时回落到第一个可用的, 免得开窗空白
      const { petId } = get();
      if (pets.length && (!petId || !pets.some((p) => p.id === petId))) {
        localStorage.setItem(PET_ID_KEY, pets[0].id);
        set({ petId: pets[0].id });
      }
    } catch {
      set({ pets: [] });
    }
  },

  setEnabled: async (v) => {
    localStorage.setItem(ENABLED_KEY, v ? "1" : "0");
    set({ enabled: v });
    if (!v) {
      await invoke("close_pet_window").catch((e) => console.error("[pet] 关窗失败", e));
      releaseBridge();
      return;
    }
    const pet = get().pets.find((p) => p.id === get().petId) ?? get().pets[0];
    if (!pet) return; // 没有可用宠物包, 设置面板会给空态提示
    // 桥要在开窗前就绪, 否则桌宠窗口的 pet_ready 握手没人接
    await ensureBridge();
    // 加载期间用户又把开关关了: 别再开窗, 刚起的桥也放掉
    if (!get().enabled) {
      releaseBridge();
      return;
    }
    const { zoom, pos } = get();
    let foot = pos;
    if (foot && foot.v !== 2) {
      // 旧版存的是窗口左上角, 那时窗口 = 帧尺寸 × zoom (还没有画布), 按旧窗口换算成脚底点并写回,
      // 不迁移的话升级后宠物会整体往左上偏半个画布
      foot = { x: foot.x + (pet.frame_width * zoom) / 2, y: foot.y + pet.frame_height * zoom, v: 2 };
      localStorage.setItem(POS_KEY, JSON.stringify(foot));
      set({ pos: foot });
    }
    const canvas = canvasSize(pet.frame_width, pet.frame_height, zoom);
    const at = foot ? windowPosFromFoot(foot, canvas) : null;
    await invoke("open_pet_window", {
      w: canvas.w,
      h: canvas.h,
      x: at?.x,
      y: at?.y,
    }).catch((e) => console.error("[pet] 开窗失败", e));
  },

  setPetId: (id) => {
    localStorage.setItem(PET_ID_KEY, id);
    set({ petId: id });
    pushConfig();
  },

  setZoom: (z) => {
    localStorage.setItem(ZOOM_KEY, String(z));
    set({ zoom: z });
    pushConfig();
  },

  setGravity: (v) => {
    localStorage.setItem(GRAVITY_KEY, v ? "1" : "0");
    set({ gravity: v });
    pushConfig();
  },

  setWalk: (v) => {
    localStorage.setItem(WALK_KEY, v ? "1" : "0");
    set({ walk: v });
    pushConfig();
  },
}));

/** 把当前配置推给桌宠窗口 (窗口不存在时 emit 静默失败, 无副作用) */
export function pushConfig() {
  const { petId, zoom, gravity, walk } = usePetStore.getState();
  const cfg: PetConfig = { petId, zoom, gravity, walk, theme: readTheme() };
  emitTo("pet", "pet_config", cfg).catch(() => {});
}
