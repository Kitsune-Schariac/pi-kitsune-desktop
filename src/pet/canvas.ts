// 桌宠画布尺寸: 窗口比角色大, 上方与两侧留给气泡和跳跃。透明区域由 Rust 舞台线程动态穿透。
// 主窗口开窗 (store/pet.ts) 与桌宠窗口排版 (PetWindow.tsx) 必须用同一组倍数, 所以单独放这里,
// 也避免桌宠窗口为了两个常量去 import 主窗口的 store
const CANVAS_SCALE_W = 2;
const CANVAS_SCALE_H = 1.6;

/**
 * 宠物位置以"脚底点"(角色底边中点, 逻辑坐标) 记录, 不记窗口左上角: 画布比角色大且随缩放变化,
 * 左上角代表不了角色站在哪。v: 2 是格式标记, 旧版存的是窗口左上角 (没有 v), 读到要先迁移
 */
export interface FootPos {
  x: number;
  y: number;
  v: 2;
}

/** 角色贴画布底边、水平居中, 所以脚底点 = 画布底边中点 */
export function windowPosFromFoot(foot: { x: number; y: number }, canvas: { w: number; h: number }) {
  return { x: foot.x - canvas.w / 2, y: foot.y - canvas.h };
}

/** 画布逻辑尺寸; 角色贴画布底边、水平居中 */
export function canvasSize(frameW: number, frameH: number, zoom: number) {
  return {
    w: Math.round(frameW * zoom * CANVAS_SCALE_W),
    h: Math.round(frameH * zoom * CANVAS_SCALE_H),
  };
}
