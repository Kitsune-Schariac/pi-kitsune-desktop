// 桌宠 store (主窗口侧): 配置真值 + 多会话状态聚合 + 与桌宠窗口的事件桥
// 契约对齐 Rust pets.rs (serde 序列化, snake_case 字段)
//
// 桌宠窗口是纯受控端, 配置只在这里落 localStorage —— 两个窗口同源共享 localStorage,
// 双写同一个键会有竞态, 所以桌宠侧的变更一律 emit 回来由这里统一写。
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import { useSessionStore, type SessionState } from "./session";

export type PetState = "idle" | "greet" | "thinking" | "working" | "error" | "offline";

/** Rust 侧 PetAnimation。字段名沿用 pet.json 原样 —— Rust 那边 loop_flag 带 rename = "loop",
 *  serde 的 rename 序列化方向同样生效, 传到前端就是 loop */
export interface PetAnimation {
  row: number;
  frames: number;
  /** 一轮播完的总毫秒数, 非单帧时长 */
  duration: number;
  loop: boolean;
}

/** Rust 侧 PetMeta */
export interface PetMeta {
  id: string;
  display_name: string;
  description: string;
  frame_width: number;
  frame_height: number;
  animations: Record<string, PetAnimation>;
}

// localStorage 键: 与现有 kitsune.* 同前缀
const ENABLED_KEY = "kitsune.petEnabled";
const PET_ID_KEY = "kitsune.petId";
const ZOOM_KEY = "kitsune.petZoom";
const POS_KEY = "kitsune.petPos";

const DEFAULT_ZOOM = 1;
// 覆盖态时长: greet 是开窗打招呼, error 是报错后的短暂定格
const GREET_MS = 2500;
const ERROR_MS = 2000;

// StrictMode 双跑 effect 防重入
let initialized = false;

interface PetStore {
  enabled: boolean;
  petId: string | null;
  zoom: number;
  pos: { x: number; y: number } | null;
  pets: PetMeta[];

  init: () => void;
  loadPets: () => Promise<void>;
  setEnabled: (v: boolean) => Promise<void>;
  setPetId: (id: string) => void;
  setZoom: (z: number) => void;
}

function readPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return typeof p?.x === "number" && typeof p?.y === "number" ? p : null;
  } catch {
    return null;
  }
}

/**
 * 多会话聚合成单一状态 (全局聚合: 任一会话在忙, 桌宠就忙)
 *
 * 只扫流式会话 —— 空闲会话不可能挂着运行中的工具; 且运行中的工具卡片必在 entries 尾部,
 * 从后往前扫有限窗口即可, 免得每次 store 变更都全量遍历上千条的长会话。
 */
function aggregate(sessions: Record<string, SessionState>): PetState {
  const list = Object.values(sessions);
  if (list.length === 0) return "offline";
  for (const s of list) {
    if (!s.isStreaming) continue;
    for (let i = s.entries.length - 1, n = 0; i >= 0 && n < 50; i--, n++) {
      const e = s.entries[i];
      if (e.kind === "tool" && e.status === "running") return "working";
    }
  }
  return list.some((s) => s.isStreaming) ? "thinking" : "idle";
}

// 时限性覆盖态: greet/error 不由 aggregate 推导, 到点自动撤销后重算
let override: PetState | null = null;
let overrideTimer: ReturnType<typeof setTimeout> | null = null;
// 上次推给桌宠的值: 每个 text_delta 都会触发 store 变更, 不去重会变成每秒几十次 IPC
let lastPushed: PetState | null = null;

function pushState() {
  const next = override ?? aggregate(useSessionStore.getState().sessions);
  if (next === lastPushed) return;
  lastPushed = next;
  emitTo("pet", "pet_state", { state: next }).catch(() => {});
}

function setOverride(state: PetState, ms: number) {
  if (overrideTimer) clearTimeout(overrideTimer);
  override = state;
  pushState();
  overrideTimer = setTimeout(() => {
    override = null;
    overrideTimer = null;
    pushState();
  }, ms);
}

export const usePetStore = create<PetStore>((set, get) => ({
  enabled: localStorage.getItem(ENABLED_KEY) === "1",
  petId: localStorage.getItem(PET_ID_KEY),
  zoom: Number(localStorage.getItem(ZOOM_KEY)) || DEFAULT_ZOOM,
  pos: readPos(),
  pets: [],

  init: () => {
    if (initialized) return;
    initialized = true;

    // 会话状态变化 → 重算并按需推送 (pushState 内部做了值去重)
    useSessionStore.subscribe(() => pushState());

    // 工具报错是瞬时事件, store 状态里留不下"刚刚发生"的痕迹, 单独挂一个监听捕获。
    // 这里只读事件不调 handleEvent, 不会让 session store 双跑 (那是 main.tsx 的活)
    listen<{ sessionId: string; event: Record<string, unknown> }>("pi_event", (e) => {
      const ev = e.payload.event;
      if (ev.type === "tool_execution_end" && ev.isError) setOverride("error", ERROR_MS);
    });

    // 桌宠窗口挂载完成 → 回推配置与当前状态。开窗瞬间就推的话, 窗口还没挂载完, 事件会丢
    listen("pet_ready", () => {
      const { petId, zoom } = get();
      emitTo("pet", "pet_config", { petId, zoom }).catch(() => {});
      lastPushed = null; // 强制下一次推送, 让新开的窗口拿到当前态
      setOverride("greet", GREET_MS);
    });

    // 桌宠窗口侧的变更回传 (滚轮缩放 / 拖动落点 / 右键切角色或关闭)
    listen<{ zoom?: number; petId?: string; pos?: { x: number; y: number } | null; enabled?: boolean }>(
      "pet_patch",
      (e) => {
        const p = e.payload;
        if (typeof p.zoom === "number") {
          localStorage.setItem(ZOOM_KEY, String(p.zoom));
          set({ zoom: p.zoom });
        }
        if (typeof p.petId === "string") {
          localStorage.setItem(PET_ID_KEY, p.petId);
          set({ petId: p.petId });
          emitTo("pet", "pet_config", { petId: p.petId, zoom: get().zoom }).catch(() => {});
        }
        if (p.pos !== undefined) {
          if (p.pos === null) localStorage.removeItem(POS_KEY);
          else localStorage.setItem(POS_KEY, JSON.stringify(p.pos));
          set({ pos: p.pos });
        }
        if (p.enabled === false) void get().setEnabled(false);
      },
    );

    // 必须等宠物列表拉回来再开窗: setEnabled 要从 pets 里挑角色算窗口尺寸,
    // 抢跑会读到空列表直接静默 return, 表现为"上次开着但重启后不出来"
    void (async () => {
      await get().loadPets();
      if (get().enabled) await get().setEnabled(true);
    })();
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
      return;
    }
    const { pets, petId, zoom, pos } = get();
    const pet = pets.find((p) => p.id === petId) ?? pets[0];
    if (!pet) return; // 没有可用宠物包, 设置面板会给空态提示
    await invoke("open_pet_window", {
      w: Math.round(pet.frame_width * zoom),
      h: Math.round(pet.frame_height * zoom),
      x: pos?.x,
      y: pos?.y,
    }).catch((e) => console.error("[pet] 开窗失败", e));
  },

  setPetId: (id) => {
    localStorage.setItem(PET_ID_KEY, id);
    set({ petId: id });
    emitTo("pet", "pet_config", { petId: id, zoom: get().zoom }).catch(() => {});
  },

  setZoom: (z) => {
    localStorage.setItem(ZOOM_KEY, String(z));
    set({ zoom: z });
    emitTo("pet", "pet_config", { petId: get().petId, zoom: z }).catch(() => {});
  },
}));
