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
import type { PetAction, PetActivate, PetConfig, PetMeta, PetSignals } from "../store/pet";
import { canvasSize, windowPosFromFoot } from "./canvas";
import { onStageEvent, pressDown, startStage } from "./stage";
import { Bubble, setBadge, showBubble } from "./Bubble";
import { bodyTransform, breathScale, msToNextBreath, setDangling, squash } from "./effects";
import { createBrain, type Brain, type BrainCommand } from "./brain";

// 缩放边界: 太小看不清帧, 太大精灵图糊 (2 倍图放到 3 倍已是上限)
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;

// 大脑的定时心跳: 推进内驱力、到点的重提醒 / 醒来 / 散步超时。不重画, 只是醒一下 JS
const BRAIN_TICK_MS = 1000;

/**
 * 桌宠窗口 (label: pet, 由 ?window=pet 分流进来)
 *
 * 配置真值在主窗口的 pet store, 这里是纯受控端: mount 后 emit pet_ready 握手要配置,
 * 自身产生的变更 (滚轮缩放/拖动位置/右键切角色) 一律 emit 回主窗口落盘再推回来。
 * 这样避免两个窗口同写一份 localStorage 打架。
 *
 * 演什么由 brain.ts 决定: 这里把信号快照 / 舞台事件 / "播完一轮"喂给大脑, 再执行它回的指令。
 */
export function PetWindow() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pets, setPets] = useState<PetMeta[]>([]);
  const [pet, setPet] = useState<PetMeta | null>(null);
  // 包里每张图一份: 素材键 → data URI 与原始像素尺寸。v2 包每个动作一张横条图, 要全部加载
  const [sprites, setSprites] = useState<Record<string, { url: string; w: number; h: number }> | null>(null);
  const [zoom, setZoom] = useState(1);

  // 帧循环每帧都要读这些值, 但它们变化不该重启循环, 也不该触发重渲染 → 放 ref
  // holdUntil: 停在首帧发呆到这个时刻再开播; fresh: 下一步只重画当前帧、不推进
  // (换动作 / 换缩放后要立刻画对, 但不该因此跳过一帧)
  const animRef = useRef({
    /** 当前在播的动作, 由大脑的 play 指令设置 */
    action: null as PetAction | null,
    frame: 0,
    holdUntil: 0,
    breathe: false,
    fresh: true,
    /** 朝向与素材相反时水平镜像 (散步转身用) */
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

  const brainRef = useRef<Brain | null>(null);
  // 信号可能在宠物图片加载完、大脑建出来之前就到了, 留着最新一份给大脑开场用
  const signalsRef = useRef<PetSignals | null>(null);
  const walkRef = useRef(true);

  // 执行大脑指令。kick=false 用在帧循环内部 (它接着就会画), 免得重入 step
  const execRef = useRef((cmds: BrainCommand[], kick = true) => {
    const st = animRef.current;
    let replay = false;
    for (const c of cmds) {
      switch (c.kind) {
        case "play":
          st.action = c.action;
          st.frame = 0;
          st.fresh = true;
          st.mirrored = c.mirrored;
          st.breathe = c.breathe;
          st.holdUntil = performance.now() + c.holdMs;
          replay = true;
          break;
        case "moveTo":
          invoke("pet_stage_move_to", { x: c.x, speed: c.speed }).catch(() => {});
          break;
        case "stopMove":
          invoke("pet_stage_stop").catch(() => {});
          break;
        case "bubble":
          showBubble(c.text, c.ms);
          break;
        case "badge":
          setBadge(c.count);
          break;
        case "activate":
          emitTo("main", "pet_activate", { sessionId: c.sessionId } satisfies PetActivate).catch(() => {});
          break;
      }
    }
    // 定时器可能正睡在发呆里, 换动作要立刻开播
    if (replay && kick) kickRef.current();
  });

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
        if (alive) setSprites(Object.fromEntries(entries));
      })
      .catch((e) => console.error("[pet] 加载宠物图片失败", e));
    return () => {
      alive = false;
    };
  }, [pet]);

  // --- 大脑: 图片就绪后按当前包建一个 (换角色就换一个新的, 内驱力本来就不持久化) ---
  useEffect(() => {
    if (!pet || !sprites) return;
    const brain = createBrain({ pet, walk: walkRef.current });
    brainRef.current = brain;
    const exec = execRef.current;

    // 散步要知道脚底在哪、工作区多宽; 之后的位置变化由舞台事件里的 foot 带给大脑
    const refreshGeometry = async (withFoot: boolean) => {
      try {
        const mon = await currentMonitor();
        const s = mon?.scaleFactor ?? 1;
        if (mon) {
          const wa = mon.workArea;
          brain.setGeometry({ left: wa.position.x / s, right: (wa.position.x + wa.size.width) / s });
        }
        if (withFoot) {
          const win = getCurrentWindow();
          const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
          brain.setGeometry({ footX: (pos.x + size.width / 2) / s });
        }
      } catch {
        // 拿不到几何信息就先不散步 (大脑在 footX 未知时不选 walk)
      }
    };
    void refreshGeometry(true);

    exec(brain.start(performance.now(), signalsRef.current));
    const tick = window.setInterval(() => exec(brain.tick(performance.now())), BRAIN_TICK_MS);
    const offStage = onStageEvent((e) => {
      exec(brain.stage(e, performance.now()));
      // 可能被拖到了另一块屏幕上
      if (e.kind === "dragEnd" || e.kind === "landed") void refreshGeometry(false);
    });
    return () => {
      window.clearInterval(tick);
      offStage();
      brainRef.current = null;
      // 旧大脑可能正让宠物走着, 别让新大脑接手一个没人管的移动
      invoke("pet_stage_stop").catch(() => {});
    };
  }, [pet, sprites]);

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
      // 呼吸跟着换帧一起更新, 不单独增加重绘次数 (透明窗每次重绘都很贵, 见 effects.ts)。
      // 只给"安静待着"的行为 (大脑决定): 挥手、跳这些本身就有大动作, 再叠呼吸反而乱
      el.style.transform = bodyTransform(st.mirrored, st.breathe ? breathScale(now) : 1);
    };
    /** 停在首帧发呆: 只为呼吸换档醒来 (0.8 秒一次), 不呼吸就一觉睡到开播 */
    const rest = (el: HTMLDivElement, p: PetMeta, a: PetAction, now: number) => {
      const st = animRef.current;
      paint(el, p, a, 0, now);
      const left = st.holdUntil - now;
      schedule(st.breathe ? Math.min(left, msToNextBreath(now)) : left);
    };
    function step() {
      timer = 0;
      const p = petRef.current;
      const el = boxRef.current;
      const st = animRef.current;
      // 宠物或图片还没就绪: 不排下一次, 就绪时由 kick 重新拉起
      if (!p || !el || !st.action) return;
      const now = performance.now();

      if (now < st.holdUntil) {
        st.fresh = false;
        rest(el, p, st.action, now);
        return;
      }
      if (st.fresh) {
        st.fresh = false;
      } else if (st.frame >= st.action.durations.length - 1) {
        // 一轮播完: 问大脑下一步 (再来一轮 / 换动作 / 先发会儿呆)。没回 play 就原样从头再播
        st.frame = 0;
        const brain = brainRef.current;
        if (brain) execRef.current(brain.roundEnd(now), false);
        st.fresh = false;
        if (now < st.holdUntil) {
          rest(el, p, st.action, now);
          return;
        }
      } else {
        st.frame += 1;
      }

      paint(el, p, st.action, st.frame, now);
      schedule(st.action.durations[st.frame]);
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

    // listen() 是 async。握手必须等监听器都注册完才能发 —— 抢跑的话主窗口的回推
    // 会打在还没订阅的窗口上直接丢掉 (开窗的打招呼就是这么丢的)
    void (async () => {
      const offSignals = await listen<PetSignals>("pet_signals", (e) => {
        signalsRef.current = e.payload;
        const brain = brainRef.current;
        if (brain) execRef.current(brain.signals(e.payload, performance.now()));
      });
      const offConfig = await listen<PetConfig>(
        "pet_config",
        (e) => {
          setZoom(e.payload.zoom);
          invoke("pet_stage_set_gravity", { on: e.payload.gravity }).catch(() => {});
          if (e.payload.walk !== walkRef.current) {
            walkRef.current = e.payload.walk;
            const brain = brainRef.current;
            if (brain) execRef.current(brain.setWalk(e.payload.walk, performance.now()));
          }
          const root = document.documentElement;
          root.dataset.base = e.payload.theme.base;
          for (const [k, v] of Object.entries(e.payload.theme.vars)) root.style.setProperty(`--${k}`, v);
          invoke<PetMeta[]>("list_pets")
            .then((list) => {
              setPets(list);
              const next = list.find((p) => p.id === e.payload.petId) ?? list[0] ?? null;
              // 每次推配置 (换皮肤、缩放) 都会重拉列表: 内容没变就别换成新对象, 否则会重载图片、
              // 重建大脑, 宠物正在干的事被打断。按内容比而不是按 id: 导入覆盖同 id 的包要能换上新素材
              setPet((cur) => (cur && next && JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
            })
            .catch(() => {});
        },
      );
      // StrictMode 会 mount→unmount→mount, 卸载后才 resolve 的监听器要就地退订免得泄漏
      if (disposed) {
        offSignals();
        offConfig();
        return;
      }
      unlisten.push(offSignals, offConfig);
      // 握手: 主窗口收到后回推 pet_config + 当前信号快照
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
                // 正走着的话先停, 不然舞台线程下一轮又把窗口推回去
                invoke("pet_stage_stop").catch(() => {});
                await getCurrentWindow().setPosition(
                  new PhysicalPosition(Math.round(at.x * s), Math.round(at.y * s)),
                );
                brainRef.current?.setGeometry({ footX: foot.x });
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
