// 桌宠画布尺寸: 窗口比角色大, 上方与两侧留给气泡和跳跃。透明区域由 Rust 舞台线程动态穿透。
// 主窗口开窗 (store/pet.ts) 与桌宠窗口排版 (PetWindow.tsx) 必须用同一组倍数, 所以单独放这里,
// 也避免桌宠窗口为了两个常量去 import 主窗口的 store
export const CANVAS_SCALE_W = 2;
export const CANVAS_SCALE_H = 1.6;

/** 画布逻辑尺寸; 角色贴画布底边、水平居中 */
export function canvasSize(frameW: number, frameH: number, zoom: number) {
  return {
    w: Math.round(frameW * zoom * CANVAS_SCALE_W),
    h: Math.round(frameH * zoom * CANVAS_SCALE_H),
  };
}
