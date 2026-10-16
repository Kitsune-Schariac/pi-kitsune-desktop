// 桌宠程序化效果层: 不改帧本身, 对任何宠物包都生效
//
// 透明窗口每次画面变化都要整窗重新合成, 代价远高于普通网页: 实测一个平滑的 CSS 呼吸动画
// (每个刷新周期都变) 让整棵进程树占到单核 15%, 所以持续性效果一律做成"分档、低频"——
// 呼吸只有 4 档, 跟着帧循环换帧时顺带更新, 发呆时 0.8 秒才换一档。
// 只有短暂的一次性效果 (落地挤压) 和本来就在大动的场景 (拖动晃动) 才用合成器动画。

/** 呼吸周期与振幅: scaleY 在 1 ~ 1 + BREATH_AMP 之间, 以脚底为原点, 脚不离地 */
const BREATH_PERIOD_MS = 3200;
const BREATH_AMP = 0.015;
/** 一个周期分 4 档 (低 → 中 → 高 → 中), 每档 800ms */
const BREATH_LEVELS = [0, 0.5, 1, 0.5];
const BREATH_STEP_MS = BREATH_PERIOD_MS / BREATH_LEVELS.length;

const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

/** 系统开了"减少动态效果": 关掉呼吸与晃动, 镜像这类表达朝向的不受影响 */
function reducedMotion(): boolean {
  return reducedQuery.matches;
}

/** 当前时刻的呼吸纵向缩放 */
export function breathScale(now: number): number {
  if (reducedMotion()) return 1;
  const idx = Math.floor(now / BREATH_STEP_MS) % BREATH_LEVELS.length;
  return 1 + BREATH_LEVELS[idx] * BREATH_AMP;
}

/** 距离下一档呼吸还有多久; 帧循环发呆时据此醒来, 不必为呼吸常驻高频 */
export function msToNextBreath(now: number): number {
  return BREATH_STEP_MS - (now % BREATH_STEP_MS);
}

/** 角色本体的 transform: 朝向镜像 × 呼吸 (原点由样式定在脚底) */
export function bodyTransform(mirrored: boolean, breath: number): string {
  return `scale(${mirrored ? -1 : 1}, ${breath})`;
}

/** 落地挤压: 先压扁再回弹, 一次性 180ms。用 Web Animations 交给合成器,
 *  作用在外层包裹元素上, 不和本体的镜像 / 呼吸抢同一个 transform */
export function squash(wrapper: HTMLElement) {
  wrapper.animate(
    // 原点写在关键帧里而不是外层元素的样式上: 外层的晃动要以头顶为支点, 挤压要以脚底为支点
    [
      { transform: "scale(1.12, 0.88)", transformOrigin: "50% 100%" },
      { transform: "scale(0.96, 1.04)", transformOrigin: "50% 100%", offset: 0.6 },
      { transform: "scale(1, 1)", transformOrigin: "50% 100%" },
    ],
    { duration: 180, easing: "ease-out" },
  );
}

/** 被拎起来时的晃动: 拖动本身就在整窗移动、画面一直在变, 这时用 CSS 动画不额外增加多少开销 */
export function setDangling(wrapper: HTMLElement, on: boolean) {
  wrapper.classList.toggle("pet-fx-dangle", on && !reducedMotion());
}
