import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  currentMonitor,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { Menu } from "@tauri-apps/api/menu";
import type { PetAction, PetConfig, PetMeta, PetState } from "../store/pet";
import { canvasSize, windowPosFromFoot } from "./canvas";
import { onStageEvent, pressDown, startStage } from "./stage";
import { Bubble } from "./Bubble";
import { bodyTransform, breathScale, msToNextBreath, setDangling, squash } from "./effects";

// 缩放边界: 太小看不清帧, 太大精灵图糊 (2 倍图放到 3 倍已是上限)
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;

// 空闲时不循环播动画, 停在首帧发呆, 隔这个区间随机时长才动一次
const IDLE_REST_MIN_MS = 5000;
const IDLE_REST_MAX_MS = 14000;

// 过渡期映射: 旧的五个状态 → 动作类别。大脑任务会整体取代 PetState, 这里先让新格式的包跑起来
const STATE_CATEGORY: Record<PetState, string> = {
  idle: "idle",
  busy: "work",
  greet: "notify",
  error: "sad",
  offline: "sad",
};

/** 在某类别的变体里按 weight 加权随机挑一个; 包里没有这个类别就退回 idle (idle 是包的必选项) */
function pickAction(p: PetMeta, category: string): PetAction {
  let pool = p.actions.filter((a) => a.category === category);
  if (!pool.length) pool = p.actions.filter((a) => a.category === "idle");
  const total = pool.reduce((sum, a) => sum + a.weight, 0);
  let r = Math.random() * total;
  for (const a of pool) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return pool[pool.length - 1];
}

/**
 * 桌宠窗口 (label: pet, 由 ?window=pet 分流进来)
 *
 * 配置真值在主窗口的 pet store, 这里是纯受控端: mount 后 emit pet_ready 握手要配置,
 * 自身产生的变更 (滚轮缩放/拖动位置/右键切角色) 一律 emit 回主窗口落盘再推回来。
 * 这样避免两个窗口同写一份 localStorage 打架。
 */
export function PetWindow() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pets, setPets] = useState<PetMeta[]>([]);
  const [pet, setPet] = useState<PetMeta | null>(null);
  // 包里每张图一份: 素材键 → data URI 与原始像素尺寸。v2 包每个动作一张横条图, 要全部加载
  const [sprites, setSprites] = useState<Record<string, { url: string; w: number; h: number }> | null>(null);
  const [zoom, setZoom] = useState(1);

  // 帧循环每帧都要读这些值, 但它们变化不该重启循环, 也不该触发重渲染 → 放 ref
  // idlePlaying/idleNextAt: 空闲发呆与下次开播时刻; fresh: 下一步只重画当前帧、不推进
  // (换状态 / 换缩放后要立刻画对, 但不该因此跳过一帧)
  const animRef = useRef({
    state: "idle" as PetState,
    /** 当前在播的动作; 换状态或忙碌时每轮重挑 */
    action: null as PetAction | null,
    frame: 0,
    idlePlaying: false,
    idleNextAt: 0,
    fresh: true,
    /** 朝向与素材相反时水平镜像 (散步转身用, 由大脑设置) */
    mirrored: false,
  });
  // 立刻跑一步帧循环 (取消已排好的定时器); 循环挂载前是空函数
  const kickRef = useRef<() => void>(() => {});
  const spritesRef = useRef(sprites);
  spritesRef.current = sprites;
  const petRef = useRef<PetMeta | null>(null);
  const zoomRef = useRef(1);
  petRef.current = pet;
  zoomRef.current = zoom;

  // --- 图片加载: data URI 交给 Image, onload 直接读真实像素尺寸 ---
  // 全部加载完才渲染, 否则换动作时会闪一下空白
  useEffect(() => {
    if (!pet) return;
    let alive = true;
    setSprites(null);
    const images = [...new Set(pet.actions.map((a) => a.image))];
    void Promise.all(
      images.map((image) =>
        invoke<string>("get_pet_asset", { petId: pet.id, image }).then(
          (url) =>
            new Promise<[string, { url: string; w: number; h: number }]>((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve([image, { url, w: img.naturalWidth, h: img.naturalHeight }]);
              img.onerror = reject;
              img.src = url;
            }),
        ),
      ),
    )
      .then((entries) => {
        if (!alive) return;
        animRef.current.action = pickAction(pet, STATE_CATEGORY[animRef.current.state]);
        animRef.current.frame = 0;
        setSprites(Object.fromEntries(entries));
      })
      .catch((e) => console.error("[pet] 加载宠物图片失败", e));
    return () => {
      alive = false;
    };
  }, [pet]);

  // --- 窗口 = 画布 (比角色大); 角色包围盒上报给舞台线程做命中, 只在角色或缩放变化时报一次 ---
  useEffect(() => {
    if (!pet) return;
    const canvas = canvasSize(pet.frame_width, pet.frame_height, zoom);
    // 换尺寸时保持脚底点不动: setSize 只改右下角, 不补位置的话缩放 / 换角色时宠物会"往右下长"。
    // 全程物理像素算, 避免逻辑坐标来回换算的舍入误差在反复缩放后累积成漂移
    const win = getCurrentWindow();
    void (async () => {
      try {
        const [pos, size, scale] = await Promise.all([
          win.outerPosition(),
          win.outerSize(),
          win.scaleFactor(),
        ]);
        const nw = Math.round(canvas.w * scale);
        const nh = Math.round(canvas.h * scale);
        if (nw === size.width && nh === size.height) return;
        const footX = pos.x + size.width / 2;
        const footY = pos.y + size.height;
        await win.setSize(new LogicalSize(canvas.w, canvas.h));
        await win.setPosition(new PhysicalPosition(Math.round(footX - nw / 2), Math.round(footY - nh)));
      } catch {
        // 窗口正在关闭等情况拿不到几何信息, 不调整即可
      }
    })();
    const w = pet.frame_width * zoom;
    const h = pet.frame_height * zoom;
    invoke("pet_stage_set_hitbox", {
      rect: { x: (canvas.w - w) / 2, y: canvas.h - h, w, h },
    }).catch(() => {});
  }, [pet, zoom]);

  // --- 帧循环: 手动改 background-position, 不走 React 状态 (每帧 setState 会把窗口拖垮) ---
  // 用定时器按"下一帧到期时间"调度, 不用 requestAnimationFrame: rAF 每个屏幕刷新周期都回调,
  // 宠物停在首帧发呆时也一样, 实测整棵进程树白占单核约 3.9%。帧动画本身才 4~10fps,
  // 定时器只在真要换帧时醒来, 发呆期间一睡就是好几秒
  useEffect(() => {
    let timer = 0;
    const schedule = (ms: number) => {
      timer = window.setTimeout(step, Math.max(0, ms));
    };
    // 呼吸只给"安静待着"的状态: 打招呼、报错这些本身就有大动作, 再叠呼吸反而乱
    const breathing = (state: PetState) => state === "idle" || state === "busy";
    const paint = (el: HTMLDivElement, p: PetMeta, a: PetAction, frame: number, now: number) => {
      const img = spritesRef.current?.[a.image];
      if (!img) return;
      const z = zoomRef.current;
      const st = animRef.current;
      // 换图 / 换缩放才改背景图与尺寸, 同一张图上换帧只动 background-position
      const key = `${a.image}@${z}`;
      if (el.dataset.sheet !== key) {
        el.dataset.sheet = key;
        el.style.backgroundImage = `url("${img.url}")`;
        el.style.backgroundSize = `${img.w * z}px ${img.h * z}px`;
      }
      el.style.backgroundPosition = `${-frame * p.frame_width * z}px ${-a.row * p.frame_height * z}px`;
      // 呼吸跟着换帧一起更新, 不单独增加重绘次数 (透明窗每次重绘都很贵, 见 effects.ts)
      el.style.transform = bodyTransform(st.mirrored, breathing(st.state) ? breathScale(now) : 1);
    };
    function step() {
      timer = 0;
      const p = petRef.current;
      const el = boxRef.current;
      const st = animRef.current;
      // 宠物或图片还没就绪: 不排下一次, 就绪时由 kick 重新拉起
      if (!p || !el || !st.action) return;
      const now = performance.now();

      // 空闲发呆: 停在首帧不动, 到点了才播一轮完整待机动画, 播完继续发呆。
      // 一直循环播 idle 会让桌宠显得很聒噪, 真人不在电脑前时它也在不停晃
      if (st.state === "idle" && !st.idlePlaying) {
        if (now < st.idleNextAt) {
          st.fresh = false;
          paint(el, p, st.action, 0, now);
          // 发呆期间只为呼吸换档醒来 (0.8 秒一次), 其余时间一直睡到下次开播
          schedule(Math.min(st.idleNextAt - now, msToNextBreath(now)));
          return;
        }
        st.idlePlaying = true;
        st.frame = 0;
        st.fresh = true;
      }

      let stopped = false;
      const frames = st.action.durations.length;
      if (st.fresh) {
        st.fresh = false;
      } else if (st.frame >= frames - 1) {
        if (st.state === "busy") {
          // 忙碌时每播完一轮在 work 变体里重挑 (允许抽到同一个, 连播两轮反而自然)
          st.action = pickAction(p, "work");
          st.frame = 0;
        } else if (st.state === "idle") {
          // 待机播完一轮 → 回到发呆, 安排下次开播的时刻
          st.idlePlaying = false;
          st.idleNextAt = now + IDLE_REST_MIN_MS + Math.random() * (IDLE_REST_MAX_MS - IDLE_REST_MIN_MS);
          st.frame = 0;
        } else if (st.state === "offline") {
          // 没有会话: 难过一轮后停在末帧 (蹲下不动), 不再排定时器, 等换状态时 kick
          st.frame = frames - 1;
          stopped = true;
        } else {
          st.frame = 0;
        }
      } else {
        st.frame += 1;
      }

      paint(el, p, st.action, st.frame, now);
      if (stopped) return;
      // 刚播完一轮待机、转入发呆的那一步: 画首帧, 之后只为呼吸换档醒来, 直到下次开播
      const resting = st.state === "idle" && !st.idlePlaying;
      schedule(resting ? Math.min(st.idleNextAt - now, msToNextBreath(now)) : st.action.durations[st.frame]);
    }
    kickRef.current = () => {
      if (timer) window.clearTimeout(timer);
      step();
    };
    step();
    return () => {
      window.clearTimeout(timer);
      kickRef.current = () => {};
    };
  }, []);

  // 图片就绪 / 缩放变化: 立刻按新尺寸重画当前帧 (发呆期间不 kick 的话要等好几秒才画对)
  useEffect(() => {
    animRef.current.fresh = true;
    kickRef.current();
  }, [sprites, zoom]);

  // --- 与主窗口的事件通道 ---
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];

    // listen() 是 async。握手必须等两个监听器都注册完才能发 —— 抢跑的话主窗口的回推
    // 会打在还没订阅的窗口上直接丢掉 (开窗的 greet 就是这么丢的)
    void (async () => {
      const offState = await listen<{ state: PetState }>("pet_state", (e) => {
        if (e.payload.state === animRef.current.state) return;
        const st = animRef.current;
        st.state = e.payload.state;
        st.frame = 0;
        st.fresh = true;
        // 进新状态立刻挑一个对应类别的动作开播
        const p = petRef.current;
        if (p) st.action = pickAction(p, STATE_CATEGORY[st.state]);
        if (st.state === "idle") {
          // 刚闲下来先播一轮待机再发呆 —— 直接静止会像卡住了
          st.idlePlaying = true;
          st.idleNextAt = 0;
        }
        // 定时器可能正睡在发呆里, 换状态要立刻开播
        kickRef.current();
      });
      const offConfig = await listen<PetConfig>(
        "pet_config",
        (e) => {
          setZoom(e.payload.zoom);
          invoke("pet_stage_set_gravity", { on: e.payload.gravity }).catch(() => {});
          const root = document.documentElement;
          root.dataset.base = e.payload.theme.base;
          for (const [k, v] of Object.entries(e.payload.theme.vars)) root.style.setProperty(`--${k}`, v);
          invoke<PetMeta[]>("list_pets")
            .then((list) => {
              setPets(list);
              setPet(list.find((p) => p.id === e.payload.petId) ?? list[0] ?? null);
            })
            .catch(() => {});
        },
      );
      // StrictMode 会 mount→unmount→mount, 卸载后才 resolve 的监听器要就地退订免得泄漏
      if (disposed) {
        offState();
        offConfig();
        return;
      }
      unlisten.push(offState, offConfig);
      // 握手: 主窗口收到后回推 pet_config + 当前 pet_state
      await emitTo("main", "pet_ready", {});
    })();

    return () => {
      disposed = true;
      unlisten.forEach((f) => f());
    };
  }, []);

  // --- 滚轮缩放 ---
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => {
        const next = Math.min(
          ZOOM_MAX,
          Math.max(ZOOM_MIN, z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)),
        );
        const rounded = Math.round(next * 10) / 10; // 浮点累加会攒出 0.7000000000000001
        if (rounded !== z) emitTo("main", "pet_patch", { zoom: rounded }).catch(() => {});
        return rounded;
      });
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  // --- 单击 / 拖动判定与落点存盘都在 stage.ts; 这里只负责订阅 Rust 舞台事件的生命周期 ---
  useEffect(() => startStage(), []);

  // --- 舞台事件驱动的程序化效果: 拎起来晃, 落地压一下 ---
  const fxRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      onStageEvent((e) => {
        const fx = fxRef.current;
        if (!fx) return;
        if (e.kind === "dragStart") setDangling(fx, true);
        else if (e.kind === "dragEnd") setDangling(fx, false);
        else if (e.kind === "landed") squash(fx);
      }),
    [],
  );

  // --- 右键菜单: 切角色 / 重置位置 / 关闭 ---
  const onContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      const items = pets.map((p) => ({
        id: `pet-${p.id}`,
        text: p.id === pet?.id ? `● ${p.name}` : `　${p.name}`,
        action: () => {
          emitTo("main", "pet_patch", { petId: p.id }).catch(() => {});
        },
      }));
      const menu = await Menu.new({
        items: [
          ...(items.length
            ? items
            : [{ id: "none", text: "（无可用宠物）", enabled: false }]),
          { item: "Separator" },
          {
            id: "reset-pos",
            text: "重置位置",
            // 就地把窗口挪回右下角并回传落盘 —— 只清持久化不动窗口的话, 用户点了没反应
            action: () => {
              void (async () => {
                if (!pet) return;
                const mon = await currentMonitor();
                if (!mon) return;
                // 用 workArea (扣掉任务栏) 而不是整块屏: 脚底贴着它的底边就不会被任务栏压住,
                // 任务栏在左 / 上 / 隐藏时也都对
                const s = mon.scaleFactor;
                const wa = mon.workArea;
                const right = (wa.position.x + wa.size.width) / s;
                const bottom = (wa.position.y + wa.size.height) / s;
                const foot = { x: right - 24 - (pet.frame_width * zoom) / 2, y: bottom, v: 2 as const };
                const at = windowPosFromFoot(foot, canvasSize(pet.frame_width, pet.frame_height, zoom));
                await getCurrentWindow().setPosition(
                  new PhysicalPosition(Math.round(at.x * s), Math.round(at.y * s)),
                );
                await emitTo("main", "pet_patch", { pos: foot });
              })();
            },
          },
          {
            id: "close",
            text: "关闭桌宠",
            action: () => {
              emitTo("main", "pet_patch", { enabled: false }).catch(() => {});
            },
          },
        ],
      });
      await menu.popup();
    },
    [pets, pet, zoom],
  );

  if (!pet || !sprites) return <div data-pet />;

  const canvas = canvasSize(pet.frame_width, pet.frame_height, zoom);
  // 外层是整张透明画布, 角色贴底居中; 交互只挂在角色上 (透明区域本来也收不到鼠标, 已被穿透)
  return (
    <div data-pet style={{ position: "relative", width: canvas.w, height: canvas.h }}>
      {/* 外层承接一次性 / 拖动效果 (挤压、晃动), 内层本体管镜像与呼吸, 两层 transform 互不覆盖 */}
      <div
        ref={fxRef}
        style={{
          position: "absolute",
          left: (canvas.w - pet.frame_width * zoom) / 2,
          bottom: 0,
          width: pet.frame_width * zoom,
          height: pet.frame_height * zoom,
        }}
      >
        <div
          ref={boxRef}
          onMouseDown={pressDown}
          onContextMenu={onContextMenu}
          style={{
            width: "100%",
            height: "100%",
            // 背景图与尺寸由帧循环按当前动作的图片设置 (v2 包每个动作一张图)
            backgroundRepeat: "no-repeat",
            imageRendering: "-webkit-optimize-contrast",
            transformOrigin: "50% 100%",
            cursor: "grab",
          }}
        />
      </div>
      <Bubble
        canvasW={canvas.w}
        canvasH={canvas.h}
        charW={pet.frame_width * zoom}
        charH={pet.frame_height * zoom}
      />
    </div>
  );
}
