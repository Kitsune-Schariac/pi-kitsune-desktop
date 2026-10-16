// 桌宠舞台的前端封装: 单击 / 拖动判定 + Rust 舞台事件转发 + 落点存盘
//
// 对外只有一个事件口 onStageEvent, 大脑 (以及调试) 订阅它即可, 不必关心事件来自
// 页面鼠标还是 Rust 舞台线程。事件走 window 上的 CustomEvent: 订阅关系不用自己维护,
// 也能直接从 devtools / CDP 观察。
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type StageEventKind =
  | "click"
  | "dragStart"
  | "dragEnd"
  | "fall"
  | "landed"
  | "arrived"
  | "edge"
  | "snapped";

export interface StageEvent {
  kind: StageEventKind;
  /** 脚底点 (逻辑像素); 只有 Rust 舞台线程发来的事件才带 */
  foot?: { x: number; y: number };
}

const EVENT_NAME = "pet-stage";

/** 位移超过这么多逻辑像素才算拖动: 手点下去难免抖一两个像素, 不能把单击吞成拖动 */
const DRAG_THRESHOLD = 4;

/** 这些事件意味着窗口被挪到了新位置, 收到就把脚底点落盘 */
const MOVED: ReadonlySet<StageEventKind> = new Set(["dragEnd", "landed", "arrived", "edge", "snapped"]);

export function onStageEvent(cb: (e: StageEvent) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<StageEvent>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

function dispatch(e: StageEvent) {
  window.dispatchEvent(new CustomEvent<StageEvent>(EVENT_NAME, { detail: e }));
}

// 一次按压的状态; 一个窗口同一时刻只会有一次按压, 用模块变量即可
let press: { x: number; y: number; dragging: boolean } | null = null;

function endPress() {
  press = null;
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", onUp);
}

function onMove(e: MouseEvent) {
  if (!press || press.dragging) return;
  // screenX/Y 是 CSS 像素, 与逻辑像素同一口径, 阈值不随 DPI 变
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < DRAG_THRESHOLD) return;
  press.dragging = true;
  // 先锁住"不穿透"再开拖, 免得快速甩动时鼠标短暂出了包围盒、窗口切成穿透把拖拽打断
  invoke("pet_stage_drag", { active: true }).catch(() => {});
  getCurrentWindow().startDragging().catch(() => {});
  dispatch({ kind: "dragStart" });
}

function onUp() {
  const p = press;
  endPress();
  invoke("pet_stage_press", { active: false }).catch(() => {});
  if (!p) return;
  if (p.dragging) {
    // 只有非 Windows 平台会走到这里: Windows 上系统拖拽的模态循环会吞掉 mouseup,
    // 拖动结束由 Rust 读鼠标键状态判定。这里通知 Rust 收尾, dragEnd 仍由它带着落点发回来
    invoke("pet_stage_drag", { active: false }).catch(() => {});
  } else {
    dispatch({ kind: "click" });
  }
}

/** 挂在角色元素的 onMouseDown 上 */
export function pressDown(e: { button: number; screenX: number; screenY: number }) {
  if (e.button !== 0) return;
  endPress();
  press = { x: e.screenX, y: e.screenY, dragging: false };
  // 按住期间锁定不穿透: 手抖出包围盒时页面仍要收到 mousemove / mouseup
  invoke("pet_stage_press", { active: true }).catch(() => {});
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** 订阅 Rust 舞台事件: 转发到事件口, 并把新落点回传主窗口落盘。返回退订函数 */
export function startStage(): () => void {
  let disposed = false;
  let off: (() => void) | null = null;
  void listen<StageEvent>("pet_stage", (ev) => {
    const e = ev.payload;
    if (e.kind === "dragEnd") {
      // Windows 上这次按压收不到 mouseup, 在这里替它收尾, 否则监听器会一直挂着
      endPress();
    }
    if (MOVED.has(e.kind) && e.foot) {
      emitTo("main", "pet_patch", { pos: { x: e.foot.x, y: e.foot.y, v: 2 } }).catch(() => {});
    }
    dispatch(e);
  }).then((f) => {
    // StrictMode 卸载后才 resolve 的监听器就地退订
    if (disposed) f();
    else off = f;
  });
  return () => {
    disposed = true;
    off?.();
    endPress();
  };
}
