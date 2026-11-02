import { useEffect, useState } from "react";
import { X, BarChart3, Palette, Activity, Boxes, Cat, type LucideIcon } from "lucide-react";
import { TokenStatsPanel } from "./TokenStatsPanel";
import { AppearancePanel } from "./AppearancePanel";
import { BehaviorStatsPanel } from "./BehaviorStatsPanel";
import { ModelsPanel } from "./ModelsPanel";
import { PetPanel } from "./PetPanel";

type TabKey = "theme" | "pet" | "stats" | "behavior" | "models";

/** 设置分区键: Rail 的「统计」「桌宠」「设置」入口直接定位到对应分区 */
export type SettingsSection = TabKey;

const NAV_ITEMS: { key: TabKey; icon: LucideIcon; title: string; desc: string }[] = [
  { key: "theme", icon: Palette, title: "外观", desc: "日间 / 夜间 / 跟随系统" },
  { key: "models", icon: Boxes, title: "模型与供应商", desc: "供应商 / 模型 / 新会话默认" },
  { key: "stats", icon: BarChart3, title: "Token 统计", desc: "用量与成本分布" },
  { key: "behavior", icon: Activity, title: "行为统计", desc: "轮次 / 工具 / 思考占比" },
  { key: "pet", icon: Cat, title: "桌宠", desc: "桌面宠物开关 / 角色 / 大小" },
];

// 设置视图: 覆盖整个窗口的全屏界面 (渲染在 #app-root 内, absolute inset-0 铺满)。
// 两栏的头部与主界面各列同高 (--bar-h), 分隔线横向贯通。
export function SettingsWindow({
  onClose,
  initialSection,
}: {
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
  const [tab, setTab] = useState<TabKey>(initialSection ?? "theme");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = NAV_ITEMS.find((it) => it.key === tab)!;

  return (
    <div data-overlay className="setwin absolute inset-0 z-50 flex view-in">
      {/* 导航列: 窗口 < 1280 收成 64px 图标栏, 说明文字靠 title 提示 */}
      <aside className="setwin-nav flex w-16 shrink-0 flex-col xl:w-56">
        <div className="bar justify-center px-3 xl:justify-between xl:pl-5">
          <span className="hidden text-lead font-semibold text-fg xl:inline">设置</span>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-md text-fg-3 transition duration-fast ease-out hover:bg-hover hover:text-fg"
            title="关闭 (Esc)"
            aria-label="关闭设置"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV_ITEMS.map(({ key, icon: Icon, title, desc }) => {
            const active = key === tab;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                aria-current={active ? "page" : undefined}
                className={`setwin-navitem flex h-9 w-full items-center justify-center gap-3 rounded-md px-3 text-left text-body xl:justify-start ${
                  active ? "on font-medium" : ""
                }`}
                title={`${title} · ${desc}`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden truncate xl:block">{title}</span>
              </button>
            );
          })}
        </nav>
        <div className="hidden h-10 shrink-0 items-center border-t border-line px-5 text-meta text-fg-4 xl:flex">
          Pi Kitsune · 设置
        </div>
      </aside>

      <div className="setwin-main flex min-w-0 flex-1 flex-col">
        <header className="bar gap-3 px-8">
          <h2 className="text-lead font-semibold text-fg">{current.title}</h2>
          <span className="truncate text-label text-fg-4">{current.desc}</span>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          {/* key 换分区即重挂载: 一次轻量淡入, 面板回到各自初始滚动位置 */}
          <div key={tab} className="h-full view-in-soft">
            {tab === "theme" && (
              <div className="h-full overflow-y-auto">
                <AppearancePanel />
              </div>
            )}
            {tab === "pet" && (
              <div className="h-full overflow-y-auto">
                <PetPanel />
              </div>
            )}
            {tab === "stats" && (
              <div className="h-full overflow-y-auto">
                <TokenStatsPanel />
              </div>
            )}
            {tab === "behavior" && (
              <div className="h-full overflow-y-auto">
                <BehaviorStatsPanel />
              </div>
            )}
            {/* ModelsPanel 自带全高多栏与内部滚动 */}
            {tab === "models" && <ModelsPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
