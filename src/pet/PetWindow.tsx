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
import type { PetAnimation, PetMeta, PetState } from "../store/pet";

// 缩放边界: 太小看不清帧, 太大精灵图糊 (2 倍图放到 3 倍已是上限)
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;

// 空闲时不循环播动画, 停在首帧发呆, 隔这个区间随机时长才动一次
const IDLE_REST_MIN_MS = 5000;
const IDLE_REST_MAX_MS = 14000;

// 忙碌动画池的内置定义: 按 hatch-pet 的 atlas 契约, row7=running(执行中) row8=review(专注),
// 这两行正好是"在干活"的两种表现。写成内置而不是依赖 pet.json —— 旧宠物包 (如薇尔莉特)
// 的映射里根本没定义 row8, 但精灵图那一行是画了的, 靠配置就享受不到随机
const BUILTIN_BUSY: PetAnimation[] = [
  { row: 7, frames: 6, duration: 900, loop: true },
  { row: 8, frames: 6, duration: 1500, loop: true },
];

/**
 * 忙碌动画池: pet.json 显式配了 stateSequences.busy 就以它为准, 否则用内置的 row7/row8。
 * totalRows 是精灵图的实际行数, 用来挡掉越界行 (不按 8x9 契约做的包不至于播出一片空白)
 */
function busyPool(pet: PetMeta, totalRows: number): PetAnimation[] {
  const names = pet.state_sequences?.busy;
  if (names?.length) {
    const picked = names.map((n) => pet.animations[n]).filter(Boolean);
    if (picked.length) return picked;
  }
  const usable = BUILTIN_BUSY.filter((a) => a.row < totalRows);
  return usable.length ? usable : [pet.animations.idle];
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
  const [sprite, setSprite] = useState<{ url: string; w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);

  // 帧循环每帧都要读这些值, 但它们变化不该重启循环, 也不该触发重渲染 → 放 ref
  // busyAnim: 忙碌时当前随机到的动画名; idlePlaying/idleNextAt: 空闲发呆与下次开播时刻
  const animRef = useRef({
    state: "idle" as PetState,
    frame: 0,
    lastTs: 0,
    busyIdx: 0,
    idlePlaying: false,
    idleNextAt: 0,
  });
  // 精灵图行数, 给忙碌池挡越界行用 (sprite 加载后才知道)
  const rowsRef = useRef(0);
  const petRef = useRef<PetMeta | null>(null);
  const zoomRef = useRef(1);
  petRef.current = pet;
  zoomRef.current = zoom;

  // --- 精灵图加载: data URI 交给 Image, onload 直接读真实像素尺寸 ---
  // (旧 Electron 版在 preload 里手写了 60 行 WebP 文件头解析干这事, 这里不需要)
  useEffect(() => {
    if (!pet) return;
    let alive = true;
    invoke<string>("get_pet_asset", { petId: pet.id })
      .then((url) => {
        const img = new Image();
        img.onload = () => {
          if (!alive) return;
          rowsRef.current = Math.floor(img.naturalHeight / pet.frame_height);
          setSprite({ url, w: img.naturalWidth, h: img.naturalHeight });
        };
        img.src = url;
      })
      .catch(() => {
        if (alive) setSprite(null);
      });
    return () => {
      alive = false;
    };
  }, [pet]);

  // --- 窗口尺寸跟随 帧尺寸 × zoom ---
  useEffect(() => {
    if (!pet) return;
    const w = Math.round(pet.frame_width * zoom);
    const h = Math.round(pet.frame_height * zoom);
    getCurrentWindow().setSize(new LogicalSize(w, h)).catch(() => {});
  }, [pet, zoom]);

  // --- 帧循环: 手动改 background-position, 不走 React 状态 (每帧 setState 会把窗口拖垮) ---
  useEffect(() => {
    let raf = 0;
    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      const p = petRef.current;
      const el = boxRef.current;
      if (!p || !el) return;

      const st = animRef.current;

      // 空闲发呆: 停在首帧不动, 到点了才播一轮完整待机动画, 播完继续发呆。
      // 一直循环播 idle 会让桌宠显得很聒噪, 真人不在电脑前时它也在不停晃
      if (st.state === "idle" && !st.idlePlaying) {
        if (ts < st.idleNextAt) return;
        st.idlePlaying = true;
        st.frame = 0;
        st.lastTs = 0;
      }

      // 忙碌时在动画池里随机取一个播, 播完一轮再随机 —— 不区分思考/执行工具
      const pool = st.state === "busy" ? busyPool(p, rowsRef.current) : null;
      const anim = pool
        ? pool[st.busyIdx % pool.length]
        : p.animations[st.state] ?? p.animations.idle;
      if (!anim || anim.frames <= 0) return;

      const perFrame = anim.duration / anim.frames;
      if (ts - st.lastTs < perFrame) return;
      st.lastTs = ts;

      if (st.frame >= anim.frames - 1) {
        if (pool) {
          // 一轮播完重新随机 (允许抽到同一个, 连播两轮反而自然)
          st.busyIdx = Math.floor(Math.random() * pool.length);
          st.frame = 0;
        } else if (st.state === "idle") {
          // 待机播完一轮 → 回到发呆, 安排下次开播的时刻
          st.idlePlaying = false;
          st.idleNextAt =
            ts + IDLE_REST_MIN_MS + Math.random() * (IDLE_REST_MAX_MS - IDLE_REST_MIN_MS);
          st.frame = 0;
        } else if (!anim.loop) {
          st.frame = anim.frames - 1; // 非循环: 停在末帧
        } else {
          st.frame = 0;
        }
      } else {
        st.frame += 1;
      }

      const z = zoomRef.current;
      const x = -animRef.current.frame * p.frame_width * z;
      const y = -anim.row * p.frame_height * z;
      el.style.backgroundPosition = `${x}px ${y}px`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

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
        st.lastTs = 0;
        if (st.state === "busy") {
          // 进忙碌态立刻随机一个动作开播, 不然要等一轮才随机
          st.busyIdx = Math.floor(Math.random() * 100);
        } else if (st.state === "idle") {
          // 刚闲下来先播一轮待机再发呆 —— 直接静止会像卡住了
          st.idlePlaying = true;
          st.idleNextAt = 0;
        }
      });
      const offConfig = await listen<{ petId: string | null; zoom: number }>(
        "pet_config",
        (e) => {
          setZoom(e.payload.zoom);
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

  // --- 左键拖动 + 拖完回传位置 ---
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const win = getCurrentWindow();
    win.startDragging().catch(() => {});
    // startDragging 是阻塞式系统拖拽, 结束后才 resolve 不了 —— 用一次性 mouseup 兜住落点
    const onUp = () => {
      window.removeEventListener("mouseup", onUp);
      void (async () => {
        try {
          // outerPosition 给的是物理像素, 而重开窗时 Rust 侧 builder.position() 收的是逻辑坐标,
          // 高 DPI 屏 (125% 缩放) 直接存物理值会让下次开窗位置偏掉 —— 存之前先换算
          const [pos, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
          const l = pos.toLogical(scale);
          await emitTo("main", "pet_patch", { pos: { x: l.x, y: l.y } });
        } catch {
          // 拿不到位置就不落盘, 下次开窗回到默认位置即可
        }
      })();
    };
    window.addEventListener("mouseup", onUp);
  }, []);

  // --- 右键菜单: 切角色 / 重置位置 / 关闭 ---
  const onContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      const items = pets.map((p) => ({
        id: `pet-${p.id}`,
        text: p.id === pet?.id ? `● ${p.display_name}` : `　${p.display_name}`,
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
                const win = getCurrentWindow();
                const mon = await currentMonitor();
                if (!mon) return;
                const sz = await win.outerSize();
                // 物理像素运算; 底部多留一截, 免得桌宠被压在任务栏下面
                const margin = Math.round(24 * mon.scaleFactor);
                const x = mon.position.x + mon.size.width - sz.width - margin;
                const y = mon.position.y + mon.size.height - sz.height - Math.round(80 * mon.scaleFactor);
                await win.setPosition(new PhysicalPosition(x, y));
                // 落盘存逻辑坐标 (Rust 侧 builder.position 按逻辑坐标解释)
                const l = new PhysicalPosition(x, y).toLogical(mon.scaleFactor);
                await emitTo("main", "pet_patch", { pos: { x: l.x, y: l.y } });
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
    [pets, pet],
  );

  if (!pet || !sprite) return <div data-pet />;

  return (
    <div
      data-pet
      ref={boxRef}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      style={{
        width: pet.frame_width * zoom,
        height: pet.frame_height * zoom,
        backgroundImage: `url("${sprite.url}")`,
        backgroundSize: `${sprite.w * zoom}px ${sprite.h * zoom}px`,
        backgroundRepeat: "no-repeat",
        imageRendering: "-webkit-optimize-contrast",
        cursor: "grab",
      }}
    />
  );
}
