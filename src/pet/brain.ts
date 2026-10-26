// 桌宠大脑 (桌宠窗口侧): 内驱力 + 行为选择 + 事件抢占与恢复, 纯逻辑
//
// 不碰 DOM / Tauri: 输入是主窗口的信号快照、舞台事件、帧循环的"播完一轮"和时钟, 输出是指令列表,
// 由 PetWindow 去换动作、挪窗口、冒气泡。时间与随机数都由调用方注入, 调试面板的"时间 ×10"
// 和 node 里的加速模拟都靠这个。
//
// 两种钟: 跟人和物理挂钩的 (连点判定、拖动收尾、走路超时、气泡时长) 用真实时间 now;
// 内驱力和行为节奏 (发呆、重提醒、困意、闲话间隔) 用虚拟时钟 t, 时间倍率只拨快后者。
import type { PetAction, PetMeta, PetSignals } from "../store/pet";
import type { StageEvent } from "./stage";

export type BrainCommand =
  /** 从首帧开播该动作; holdMs > 0 时先停在首帧这么久 (发呆) 再动 */
  | { kind: "play"; action: PetAction; mirrored: boolean; holdMs: number; breathe: boolean }
  | { kind: "moveTo"; x: number; speed: number }
  | { kind: "stopMove" }
  | { kind: "bubble"; text: string; ms: number }
  | { kind: "badge"; count: number }
  /** 呼出主窗口并切到该会话 */
  | { kind: "activate"; sessionId: string };

export interface BrainDebug {
  action: string;
  category: string;
  loopsLeft: number;
  energy: number;
  boredom: number;
  stack: string[];
  /** 最近 10 分钟 (虚拟时间) 各类别的时间占比 */
  shares: Record<string, number>;
  timeScale: number;
}

export interface Brain {
  start(now: number, signals: PetSignals | null): BrainCommand[];
  signals(s: PetSignals, now: number): BrainCommand[];
  stage(e: StageEvent, now: number): BrainCommand[];
  /** 帧循环播完当前动作的一轮 */
  roundEnd(now: number): BrainCommand[];
  /** 定时调用 (约每秒), 推进内驱力并处理到点的事 */
  tick(now: number): BrainCommand[];
  setWalk(on: boolean, now: number): BrainCommand[];
  /** 脚底 x 与工作区左右边界 (逻辑像素), 散步选目标用; 舞台事件里带的 foot 会自动更新 x */
  setGeometry(g: { footX?: number; left?: number; right?: number }): void;
  setTimeScale(k: number): void;
  debug(): BrainDebug;
}

const SEC = 1000;
const MIN = 60 * SEC;

// 内驱力: 每秒变化量。精力满→空干活约 40 分钟、闲着约 2 小时, 睡 5 分钟回满
const ENERGY_START = 0.8;
const BOREDOM_START = 0.2;
const ENERGY_WORK = -1 / 2400;
const ENERGY_SLEEP = 1 / 300;
const ENERGY_OTHER = -1 / 7200;
const BOREDOM_UP = 1 / 600;
const BOREDOM_DOWN = -1 / 120;
const BOREDOM_CLICK = 0.3;

const SLEEP_ENERGY = 0.3;
const SLEEP_IDLE_MS = 10 * MIN;
const WAKE_ENERGY = 0.95;

const ROUTINE = 9;
const PRIORITY: Record<string, number> = { drag: 1, land: 1, wait: 2, notify: 3, sad: 3, react: 4 };

const STACK_MAX = 3;
// 被打断太久的行为不再恢复: 拎起来半分钟再放下, 接着刚才那半截"打字"反而奇怪
const RESUME_STALE_MS = 30 * SEC;
const REMIND_MS = 5 * MIN;
const CLICK_WINDOW_MS = 1500;
const ANNOYED_CLICKS = 3;
const CHATTER_CHANCE = 0.15;
const CHATTER_GAP_MS = 2 * MIN;
const CHATTER_MS = 3 * SEC;
const EVENT_BUBBLE_MS = 4 * SEC;
// 一直循环播 idle 显得聒噪, 每轮之间停在首帧发会儿呆
const IDLE_HOLD_MS: [number, number] = [2 * SEC, 6 * SEC];
// Rust 在同一轮里先发 dragEnd 再发 fall, 等这么久没等到 fall 就是落在原地 (重力关或本来就在地上)
const DRAG_FALL_GRACE_MS = 300;
const WALK_DIST: [number, number] = [200, 600];
const WALK_SPEED = 60;
// 离工作区边缘留的余量 (Rust 还会再按半个身宽夹一次)
const WALK_MARGIN = 40;
// 防连抽: 上一个常规类别降权, 节奏更多变
const REPEAT_PENALTY = 0.7;
const STATS_WINDOW_MS = 10 * MIN;

const ROUTINES = ["work", "slack", "walk", "idle", "sleep"] as const;
type Routine = (typeof ROUTINES)[number];

// score(c) = base × ctx × drive × persona; sleep 的 drive 是开关 (困且长时间没活干才为 1)
// 选择权重 ≠ 时间占比: 一次 idle 要播 2~4 轮且轮间发呆 2~6 秒 (平均约 11 秒), 一次 work 约 4.5 秒,
// 所以有会话时 idle 系数压得很低; 调参要用 node 模拟器按时间占比核对 (方法见 pets spec §3.5)
const BASE: Record<Routine, number> = { work: 1, slack: 0.6, walk: 0.6, idle: 1, sleep: 3 };
const CTX_RUNNING: Record<Routine, number> = { work: 4, slack: 1, walk: 0.3, idle: 0.15, sleep: 0 };
const CTX_IDLE: Record<Routine, number> = { work: 1, slack: 1, walk: 1, idle: 1, sleep: 1 };
// react 不是常规行为, 它的系数作用在单击反应的期望轮数上 (playful 平均 1.5 轮)
const PERSONA: Record<PetMeta["personality"], Record<Routine | "react", number>> = {
  default: { work: 1, slack: 1, walk: 1, sleep: 1, idle: 1, react: 1 },
  diligent: { work: 1.8, slack: 0.5, walk: 0.7, sleep: 0.6, idle: 1, react: 1 },
  lazy: { work: 0.6, slack: 1.8, walk: 0.8, sleep: 2, idle: 1, react: 1 },
  playful: { work: 0.8, slack: 1.2, walk: 1.8, sleep: 0.7, idle: 1, react: 1.5 },
};

// 包里没写 loops 时的兜底; 这些类别之外的常规行为播一轮
const FALLBACK_LOOPS: Record<string, [number, number]> = { idle: [2, 4], work: [3, 6], slack: [1, 2] };
// 持续到条件解除 / 到达 / 落地, 不按轮数结束
const CONTINUOUS = new Set(["walk", "sleep", "wait", "drag"]);
// 被打断时不压栈: 条件类事件结束后若条件仍成立会重新进入; 睡觉被吵醒改压一轮 idle
const NO_STACK = new Set(["wait", "drag", "land", "sleep"]);
const BREATHE = new Set(["idle", "work", "sleep"]);

const DEFAULT_LINES: Record<string, string> = {
  notify: "{session} 做完啦",
  wait: "{session} 在等你批准",
  error: "出错了",
  annoyed: "别戳啦",
};

interface Behavior {
  /** 逻辑类别: 缺素材退回 idle 动作时仍记原类别, 抢占判断与统计都按它 */
  category: string;
  action: PetAction;
  mirrored: boolean;
  loopsLeft: number;
  priority: number;
  interruptedAt: number;
  /** 散步目标 x; 非散步为 null */
  walkTo: number | null;
  /** 散步超时 (真实时间): 没收到 arrived / edge 也要收场, 别卡在走路动画里 */
  walkUntil: number;
}

export function createBrain(opts: { pet: PetMeta; walk: boolean; random?: () => number }): Brain {
  const { pet } = opts;
  const rnd = opts.random ?? Math.random;
  const persona = PERSONA[pet.personality] ?? PERSONA.default;
  let walkOn = opts.walk;

  let timeScale = 1;
  let lastReal = 0;
  let t = 0;
  let energy = ENERGY_START;
  let boredom = BOREDOM_START;

  let sig: PetSignals = { running: 0, pending: [], waiting: [], errorSeq: 0 };
  let badge = 0;
  let idleSince = 0;
  // 已提醒过的待看会话 / 首次看到时刻 (被挡住太久就静默算提醒过, 由重提醒兜底)
  const announced = new Set<string>();
  const seenAt = new Map<string, number>();
  let lastRemindAt = 0;
  let announcedErrorSeq = 0;
  let errorAt: number | null = null;

  let current: Behavior;
  const stack: Behavior[] = [];
  let lastRoutine: string | null = null;
  let lastReact: string | null = null;
  const clicks: number[] = [];
  let dragEndAt: number | null = null;
  let falling = false;
  let footX: number | null = null;
  let area: { left: number; right: number } | null = null;
  let lastChatterAt = -Infinity;
  let bubbleUntil = 0;

  const segments: { category: string; from: number; to: number | null }[] = [];

  const variants = (category: string) => pet.actions.filter((a) => a.category === category);
  const has = (category: string) => pet.actions.some((a) => a.category === category);
  const randIn = ([lo, hi]: [number, number]) => lo + rnd() * (hi - lo);

  function weighted<T>(items: T[], w: (x: T) => number): T | null {
    const total = items.reduce((sum, x) => sum + Math.max(0, w(x)), 0);
    if (total <= 0) return null;
    let r = rnd() * total;
    for (const x of items) {
      r -= Math.max(0, w(x));
      if (r <= 0) return x;
    }
    return items[items.length - 1];
  }

  function line(group: string, session?: string): string | null {
    const list = pet.lines[group];
    const raw = list?.length ? list[Math.floor(rnd() * list.length)] : DEFAULT_LINES[group];
    if (!raw) return null;
    return raw.replace(/\{session\}/g, session ?? "");
  }

  function advance(now: number) {
    const dt = Math.max(0, now - lastReal) * timeScale;
    lastReal = now;
    t += dt;
    const sec = dt / SEC;
    const c = current?.category;
    energy += sec * (c === "work" ? ENERGY_WORK : c === "sleep" ? ENERGY_SLEEP : ENERGY_OTHER);
    boredom += sec * (c === "slack" || c === "walk" || c === "react" ? BOREDOM_DOWN : c === "sleep" ? 0 : BOREDOM_UP);
    energy = Math.min(1, Math.max(0, energy));
    boredom = Math.min(1, Math.max(0, boredom));
  }

  /** 造一个行为。action 不传则在该类别变体里按 weight 挑, 类别缺失退回 idle */
  function behave(category: string, priority: number, loops?: number, action?: PetAction): Behavior {
    const a = action ?? weighted(variants(category), (x) => x.weight) ?? weighted(variants("idle"), (x) => x.weight)!;
    let n = loops;
    if (n === undefined) {
      if (CONTINUOUS.has(category)) n = Infinity;
      else if (priority !== ROUTINE) n = 1;
      else {
        const range = a.loops ?? FALLBACK_LOOPS[category] ?? [1, 1];
        n = Math.round(randIn(range));
      }
    }
    return { category, action: a, mirrored: false, loopsLeft: Math.max(1, n), priority, interruptedAt: 0, walkTo: null, walkUntil: 0 };
  }

  /** 散步: 目标 = 当前 ± 200~600, 往屏幕中线偏; 朝向找 facing 匹配的变体, 没有就镜像 */
  function behaveWalk(now: number): Behavior | null {
    if (footX === null) return null;
    let dir = 1;
    if (area) {
      const center = (area.left + area.right) / 2;
      const half = Math.max(1, (area.right - area.left) / 2);
      // 在中线右边越远越倾向往左走, 免得一路走到屏幕边上贴着
      const pLeft = Math.min(0.9, Math.max(0.1, 0.5 + ((footX - center) / half) * 0.4));
      dir = rnd() < pLeft ? -1 : 1;
    } else {
      dir = rnd() < 0.5 ? -1 : 1;
    }
    const dist = randIn(WALK_DIST);
    let to = footX + dir * dist;
    if (area) {
      const lo = area.left + WALK_MARGIN;
      const hi = area.right - WALK_MARGIN;
      if (to < lo || to > hi) {
        // 这边走不开就掉头
        to = Math.min(hi, Math.max(lo, footX - dir * dist));
      }
    }
    if (Math.abs(to - footX) < 20) return null;
    const b = behave("walk", ROUTINE);
    return aimWalk(b, to, now);
  }

  function aimWalk(b: Behavior, to: number, now: number): Behavior {
    const facing = to >= (footX ?? to) ? "right" : "left";
    const pool = variants("walk");
    const matched = pool.filter((a) => (a.facing ?? "right") === facing);
    b.action = weighted(matched.length ? matched : pool, (x) => x.weight) ?? b.action;
    b.mirrored = (b.action.facing ?? "right") !== facing;
    b.walkTo = to;
    const speed = b.action.speed ?? WALK_SPEED;
    b.walkUntil = now + (Math.abs(to - (footX ?? to)) / speed) * SEC + 5 * SEC;
    return b;
  }

  function play(b: Behavior, holdMs = 0): BrainCommand {
    return { kind: "play", action: b.action, mirrored: b.mirrored, holdMs: holdMs / timeScale, breathe: BREATHE.has(b.category) };
  }

  function bubble(cmds: BrainCommand[], text: string | null, ms: number, now: number) {
    if (!text) return;
    bubbleUntil = now + ms;
    cmds.push({ kind: "bubble", text, ms });
  }

  function enter(b: Behavior, cmds: BrainCommand[], now: number) {
    current = b;
    const seg = segments[segments.length - 1];
    if (seg) seg.to = t;
    segments.push({ category: b.category, from: t, to: null });
    while (segments.length > 1 && segments[0].to !== null && segments[0].to < t - STATS_WINDOW_MS) segments.shift();

    cmds.push(play(b));
    if (b.walkTo !== null) cmds.push({ kind: "moveTo", x: b.walkTo, speed: b.action.speed ?? WALK_SPEED });
    if (b.priority === ROUTINE) {
      lastRoutine = b.category;
      // 闲话: 常规行为开始时偶尔冒一句, 全局限频, 不盖住还挂着的事件气泡
      const list = pet.lines[b.category];
      if (list?.length && now >= bubbleUntil && t - lastChatterAt >= CHATTER_GAP_MS && rnd() < CHATTER_CHANCE) {
        lastChatterAt = t;
        bubble(cmds, line(b.category), CHATTER_MS, now);
      }
    }
  }

  /** 事件抢占当前行为; 当前行为按需压栈等恢复 */
  function preempt(next: Behavior, cmds: BrainCommand[], now: number) {
    const cur = current;
    if (cur.walkTo !== null) cmds.push({ kind: "stopMove" });
    if (cur.category === "sleep") {
      // 被吵醒: 事件结束后先懵一轮 idle 再说
      const wake = behave("idle", ROUTINE, 1);
      wake.interruptedAt = t;
      stack.push(wake);
    } else if (!NO_STACK.has(cur.category) && cur.priority > next.priority) {
      // 同优先级的事件直接替换不压栈: 提醒接着报错, 没必要回头把提醒再播一遍
      cur.interruptedAt = t;
      stack.push(cur);
    }
    if (stack.length > STACK_MAX) stack.shift();
    enter(next, cmds, now);
  }

  function take(b: Behavior, cmds: BrainCommand[], now: number, free: boolean) {
    if (free) enter(b, cmds, now);
    else preempt(b, cmds, now);
  }

  /**
   * 电平触发的事件: 等审批、新完成、重提醒、报错。被更高优先级挡住时先挂着, 能播了再播;
   * 挂太久的完成 / 报错静默作废 (角标和重提醒兜底)。free 表示当前行为已结束, 谁都能接手
   */
  function fireEvents(cmds: BrainCommand[], now: number, free: boolean, atRoundEnd = false): boolean {
    const canTake = (p: number) =>
      free ||
      // 常规行为: interruptible 为 false 的 (比如一个完整的伸懒腰) 等这一轮播完再让
      (current.priority === ROUTINE ? current.action.interruptible || atRoundEnd : p <= current.priority);

    for (const p of sig.pending) {
      if (!announced.has(p.sessionId) && t - (seenAt.get(p.sessionId) ?? t) > RESUME_STALE_MS) announced.add(p.sessionId);
    }
    if (errorAt !== null && t - errorAt > RESUME_STALE_MS) {
      announcedErrorSeq = sig.errorSeq;
      errorAt = null;
    }

    if (sig.waiting.length && current.category !== "wait" && canTake(PRIORITY.wait)) {
      take(behave("wait", PRIORITY.wait), cmds, now, free);
      bubble(cmds, line("wait", sig.waiting[0].name), EVENT_BUBBLE_MS, now);
      return true;
    }
    const fresh = sig.pending.filter((p) => !announced.has(p.sessionId));
    if (fresh.length && canTake(PRIORITY.notify)) {
      fresh.forEach((p) => announced.add(p.sessionId));
      lastRemindAt = t;
      take(behave("notify", PRIORITY.notify), cmds, now, free);
      bubble(cmds, line("notify", fresh[fresh.length - 1].name), EVENT_BUBBLE_MS, now);
      return true;
    }
    if (sig.pending.length && t - lastRemindAt >= REMIND_MS && canTake(PRIORITY.notify)) {
      lastRemindAt = t;
      take(behave("notify", PRIORITY.notify), cmds, now, free);
      bubble(cmds, `还有 ${sig.pending.length} 个会话等你看`, EVENT_BUBBLE_MS, now);
      return true;
    }
    if (sig.errorSeq > announcedErrorSeq && canTake(PRIORITY.sad)) {
      announcedErrorSeq = sig.errorSeq;
      errorAt = null;
      take(behave("sad", PRIORITY.sad), cmds, now, free);
      bubble(cmds, line("error"), EVENT_BUBBLE_MS, now);
      return true;
    }
    return false;
  }

  function chooseRoutine(now: number): Behavior {
    const running = sig.running > 0;
    const ctx = running ? CTX_RUNNING : CTX_IDLE;
    const sleepy = !running && t - idleSince >= SLEEP_IDLE_MS && energy < SLEEP_ENERGY;
    const score = (c: Routine) => {
      if (!has(c)) return 0;
      if (c === "walk" && (!walkOn || footX === null)) return 0;
      const drive =
        c === "work" ? 0.4 + 0.6 * energy
        : c === "slack" || c === "walk" ? 0.5 + 2 * boredom
        : c === "sleep" ? (sleepy ? 1 : 0)
        : 1;
      return BASE[c] * ctx[c] * drive * persona[c] * (c === lastRoutine ? REPEAT_PENALTY : 1);
    };
    const c = weighted([...ROUTINES], score) ?? "idle";
    if (c === "walk") return behaveWalk(now) ?? behave("idle", ROUTINE);
    return behave(c, ROUTINE);
  }

  /** 当前行为结束: 先接挂着的事件, 再恢复被打断的, 都没有就重新挑 */
  function finish(cmds: BrainCommand[], now: number) {
    if (fireEvents(cmds, now, true)) return;
    while (stack.length) {
      const b = stack.pop()!;
      if (b.loopsLeft <= 0 || t - b.interruptedAt > RESUME_STALE_MS) continue;
      if (b.category === "walk") {
        if (b.walkTo === null || !walkOn) continue;
        aimWalk(b, b.walkTo, now);
      }
      enter(b, cmds, now);
      return;
    }
    enter(chooseRoutine(now), cmds, now);
  }

  function checkTimers(cmds: BrainCommand[], now: number) {
    const c = current.category;
    if (c === "sleep" && (sig.running > 0 || energy >= WAKE_ENERGY)) {
      enter(behave("idle", ROUTINE, 1), cmds, now);
    } else if (c === "walk" && now > current.walkUntil) {
      cmds.push({ kind: "stopMove" });
      current.walkTo = null;
      finish(cmds, now);
    } else if (c === "drag" && dragEndAt !== null && !falling && now - dragEndAt > DRAG_FALL_GRACE_MS) {
      dragEndAt = null;
      finish(cmds, now);
    }
  }

  function syncBadge(cmds: BrainCommand[]) {
    if (sig.pending.length === badge) return;
    badge = sig.pending.length;
    cmds.push({ kind: "badge", count: badge });
  }

  return {
    start(now, signals) {
      lastReal = now;
      const cmds: BrainCommand[] = [];
      if (signals) sig = signals;
      // 开窗前就有的待看 / 报错不算"刚发生": 角标照常显示, 重提醒从现在起算
      sig.pending.forEach((p) => announced.add(p.sessionId));
      announcedErrorSeq = sig.errorSeq;
      lastRemindAt = t;
      idleSince = t;
      syncBadge(cmds);
      // 开场: 有 notify 就挥手打招呼, 没有就是一轮 idle (behave 自动退回)
      current = behave("notify", PRIORITY.notify);
      enter(current, cmds, now);
      bubble(cmds, pet.lines.greet?.length ? line("greet") : null, EVENT_BUBBLE_MS, now);
      fireEvents(cmds, now, false);
      return cmds;
    },

    signals(s, now) {
      advance(now);
      const cmds: BrainCommand[] = [];
      if (s.running === 0 && sig.running > 0) idleSince = t;
      if (s.errorSeq > sig.errorSeq && errorAt === null) errorAt = t;
      sig = s;
      const ids = new Set(s.pending.map((p) => p.sessionId));
      // 已确认的会话移出记录, 同一会话以后再完成还能再提醒
      for (const id of [...announced]) if (!ids.has(id)) announced.delete(id);
      for (const id of [...seenAt.keys()]) if (!ids.has(id)) seenAt.delete(id);
      for (const id of ids) if (!seenAt.has(id)) seenAt.set(id, t);
      syncBadge(cmds);
      if (!fireEvents(cmds, now, false)) {
        if (current.category === "wait" && !s.waiting.length) finish(cmds, now);
        else checkTimers(cmds, now);
      }
      return cmds;
    },

    stage(e, now) {
      advance(now);
      const cmds: BrainCommand[] = [];
      if (e.foot) footX = e.foot.x;
      switch (e.kind) {
        case "click": {
          boredom = Math.max(0, boredom - BOREDOM_CLICK);
          // 有待处理的事: 单击就是"带我去看", 等审批优先于完成
          const target = sig.waiting[0] ?? sig.pending[0];
          if (target) {
            cmds.push({ kind: "activate", sessionId: target.sessionId });
            break;
          }
          while (clicks.length && now - clicks[0] > CLICK_WINDOW_MS) clicks.shift();
          clicks.push(now);
          const canReact =
            current.priority === ROUTINE ? current.action.interruptible : PRIORITY.react <= current.priority;
          if (!canReact) break;
          if (clicks.length >= ANNOYED_CLICKS) {
            // 连戳: 换一个和上次不同的 react 变体, 没有就委屈一下
            const others = variants("react").filter((a) => a.name !== lastReact);
            const a = weighted(others, (x) => x.weight) ?? weighted(variants("sad"), (x) => x.weight) ?? undefined;
            const b = behave("react", PRIORITY.react, 1, a);
            lastReact = b.action.name;
            take(b, cmds, now, false);
            bubble(cmds, line("annoyed"), EVENT_BUBBLE_MS, now);
            clicks.length = 0;
          } else {
            const rounds = 1 + (rnd() < persona.react - 1 ? 1 : 0);
            const b = behave("react", PRIORITY.react, rounds);
            lastReact = b.action.name;
            take(b, cmds, now, false);
          }
          break;
        }
        case "dragStart":
          dragEndAt = null;
          falling = false;
          // 物理过程最高优先级, interruptible 为 false 的也立刻让
          if (current.category !== "drag") preempt(behave("drag", PRIORITY.drag), cmds, now);
          // 被拎到别处了, 原来的散步目标没意义, 落地后重新挑
          for (let i = stack.length - 1; i >= 0; i--) if (stack[i].category === "walk") stack.splice(i, 1);
          break;
        case "dragEnd":
          dragEndAt = now;
          break;
        case "fall":
          falling = true;
          break;
        case "landed":
          falling = false;
          dragEndAt = null;
          if (current.category === "drag") enter(behave("land", PRIORITY.land), cmds, now);
          break;
        case "arrived":
        case "edge":
          if (current.category === "walk") {
            current.walkTo = null;
            finish(cmds, now);
          }
          break;
        case "snapped":
          break;
      }
      return cmds;
    },

    roundEnd(now) {
      advance(now);
      const cmds: BrainCommand[] = [];
      const b = current;
      b.loopsLeft -= 1;
      if (fireEvents(cmds, now, false, true)) return cmds;
      checkTimers(cmds, now);
      if (current !== b) return cmds;
      if (b.loopsLeft > 0) {
        const hold = b.category === "idle" && b.priority === ROUTINE ? randIn(IDLE_HOLD_MS) : 0;
        cmds.push(play(b, hold));
      } else {
        finish(cmds, now);
      }
      return cmds;
    },

    tick(now) {
      advance(now);
      const cmds: BrainCommand[] = [];
      while (clicks.length && now - clicks[0] > CLICK_WINDOW_MS) clicks.shift();
      if (!fireEvents(cmds, now, false)) checkTimers(cmds, now);
      return cmds;
    },

    setWalk(on, now) {
      advance(now);
      walkOn = on;
      const cmds: BrainCommand[] = [];
      if (on) return cmds;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].category === "walk") stack.splice(i, 1);
      if (current.category === "walk") {
        cmds.push({ kind: "stopMove" });
        current.walkTo = null;
        finish(cmds, now);
      }
      return cmds;
    },

    setGeometry(g) {
      if (g.footX !== undefined) footX = g.footX;
      if (g.left !== undefined && g.right !== undefined) area = { left: g.left, right: g.right };
    },

    setTimeScale(k) {
      timeScale = Math.max(0.1, k);
    },

    debug() {
      const from = t - STATS_WINDOW_MS;
      const acc: Record<string, number> = {};
      let total = 0;
      for (const s of segments) {
        const d = Math.max(0, (s.to ?? t) - Math.max(from, s.from));
        if (d <= 0) continue;
        acc[s.category] = (acc[s.category] ?? 0) + d;
        total += d;
      }
      const shares: Record<string, number> = {};
      for (const [k, v] of Object.entries(acc)) shares[k] = total ? v / total : 0;
      return {
        action: current.action.name,
        category: current.category,
        loopsLeft: current.loopsLeft,
        energy,
        boredom,
        stack: stack.map((b) => b.category),
        shares,
        timeScale,
      };
    },
  };
}
