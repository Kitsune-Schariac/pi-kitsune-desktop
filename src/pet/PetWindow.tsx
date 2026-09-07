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
import type { PetMeta, PetState } from "../store/pet";

// 缩放边界: 太小看不清帧, 太大精灵图糊 (2 倍图放到 3 倍已是上限)
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;

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
  const animRef = useRef({ state: "idle" as PetState, frame: 0, lastTs: 0 });
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
          if (alive) setSprite({ url, w: img.naturalWidth, h: img.naturalHeight });
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

      // 缺失状态回落 idle (list_pets 已保证 idle 必然存在)
      const anim = p.animations[animRef.current.state] ?? p.animations.idle;
      if (!anim || anim.frames <= 0) return;

      const perFrame = anim.duration / anim.frames;
      if (ts - animRef.current.lastTs < perFrame) return;
      animRef.current.lastTs = ts;

      if (!anim.loop && animRef.current.frame >= anim.frames - 1) {
        animRef.current.frame = anim.frames - 1; // 非循环: 停在末帧
      } else {
        animRef.current.frame = (animRef.current.frame + 1) % anim.frames;
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
        animRef.current.state = e.payload.state;
        animRef.current.frame = 0;
        animRef.current.lastTs = 0;
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
