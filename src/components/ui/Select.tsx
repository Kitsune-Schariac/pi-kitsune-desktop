import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

// 下拉原语: 自绘触发钮 + 浮层菜单 (不再用原生 <select>, 弹出列表也走卡片 + 阴影 + 衬线)。
// 菜单挂到 body (fixed 定位), 不会被设置页各栏的 overflow 裁掉; 滚动 / 缩放窗口即收起。
// 键盘: 触发钮上 ↓ / Enter / 空格展开; 菜单里 ↑↓ 移动、Enter 选中、Esc / Tab 收起。

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** 触发钮上显示的文字 (label 是富内容时用) */
  text?: string;
  title?: string;
  disabled?: boolean;
}

const DENSITY = {
  md: "h-8 pl-3 pr-2 text-body",
  sm: "h-7 pl-3 pr-2 text-label",
} as const;

export type SelectDensity = keyof typeof DENSITY;

const MENU_MAX_H = 288;

export function Select({
  value,
  options,
  onChange,
  placeholder = "请选择",
  density = "md",
  disabled = false,
  className = "",
  menuClassName = "",
  title,
  ariaLabel,
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  density?: SelectDensity;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIdx = options.findIndex((o) => o.value === value);
  const selected = selectedIdx >= 0 ? options[selectedIdx] : null;

  // 展开时按触发钮位置定位; 下方放不下就向上翻
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const up = below < Math.min(MENU_MAX_H, options.length * 32 + 12) && r.top > below;
    setPos({
      position: "fixed",
      left: Math.min(r.left, window.innerWidth - Math.max(r.width, 160) - 8),
      minWidth: r.width,
      maxWidth: Math.max(r.width, 360),
      maxHeight: Math.min(MENU_MAX_H, (up ? r.top : below) - 8),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }, [open, options.length]);

  // 外部点击 / 滚动 / 缩放即收起 (菜单内部的滚动除外)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // 键盘移动时让当前项保持可见
  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openMenu = () => {
    if (disabled) return;
    setActive(selectedIdx >= 0 ? selectedIdx : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };

  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setOpen(false);
    btnRef.current?.focus({ preventScroll: true });
    if (o.value !== value) onChange(o.value);
  };

  const step = (dir: 1 | -1) => {
    if (options.length === 0) return;
    let i = active;
    for (let n = 0; n < options.length; n++) {
      i = (i + dir + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActive(i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      // 别让设置窗的 Esc 关闭监听也收到
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={`inline-flex min-w-0 shrink-0 items-center gap-2 rounded-md border bg-card text-left shadow-sm outline-none transition duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-40 ${
          open
            ? "border-line-2 shadow-[var(--shadow-sm),0_0_0_3px_var(--accent-soft)]"
            : "border-edge hover:border-line"
        } ${DENSITY[density]} ${className}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-fg" : "text-fg-4"}`}>
          {selected ? (selected.text ?? selected.label) : placeholder}
        </span>
        <ChevronDown
          className={`h-[14px] w-[14px] shrink-0 text-fg-4 transition-transform duration-fast ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            style={pos}
            className={`popover z-[100] overflow-y-auto p-1 view-in-soft ${menuClassName}`}
            // 菜单里的点击不能让触发钮失焦后又被外部点击判定关闭
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.length === 0 && <div className="px-3 py-2 text-body text-fg-4">无选项</div>}
            {options.map((o, i) => {
              const on = o.value === value;
              return (
                <div
                  key={o.value}
                  id={`${listId}-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={on}
                  aria-disabled={o.disabled}
                  title={o.title}
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onClick={() => pick(i)}
                  className={`flex h-8 cursor-pointer items-center gap-2 rounded-md px-3 text-body ${
                    o.disabled ? "cursor-not-allowed opacity-40" : ""
                  } ${i === active ? "bg-hover" : ""} ${on ? "font-medium text-fg" : "text-fg-2"}`}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {on && <Check className="h-[14px] w-[14px] shrink-0 text-fg" />}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
