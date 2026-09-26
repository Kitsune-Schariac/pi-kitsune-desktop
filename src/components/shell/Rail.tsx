import {
  MessagesSquare, Sparkles, Package, ChartNoAxesColumn, Cat, Settings2,
} from "lucide-react";
import { useUiStore } from "../../store/ui";
import type { SettingsSection } from "../settings/SettingsWindow";

/**
 * 图标轨 (框架 C 第一列): 会话开关会话列表, Skill / Package 开抽屉,
 * 统计 / 桌宠 / 设置直接打开设置窗的对应分区。
 * 激活态形态按 data-style 分支 (工坊 = 左缘竖条, 舞台 = accent 实心块, 见 index.css .rail-btn)。
 */
export function Rail({
  onOpenPanel,
  onOpenSettings,
}: {
  onOpenPanel: (kind: "skills" | "packages") => void;
  onOpenSettings: (section: SettingsSection) => void;
}) {
  const paneOpen = useUiStore((s) => s.paneOpen);
  const togglePane = useUiStore((s) => s.togglePane);

  return (
    <nav
      className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-[var(--line)] bg-[var(--rail)] py-2"
      aria-label="主导航"
    >
      <button
        className={`rail-btn ${paneOpen ? "on" : ""}`}
        onClick={togglePane}
        title="会话"
        aria-label="会话"
        aria-pressed={paneOpen}
      >
        <MessagesSquare className="h-[18px] w-[18px]" />
      </button>
      <button className="rail-btn" onClick={() => onOpenPanel("skills")} title="Skill" aria-label="Skill">
        <Sparkles className="h-[18px] w-[18px]" />
      </button>
      <button
        className="rail-btn"
        onClick={() => onOpenPanel("packages")}
        title="pi Package"
        aria-label="pi Package"
      >
        <Package className="h-[18px] w-[18px]" />
      </button>
      <button
        className="rail-btn"
        onClick={() => onOpenSettings("stats")}
        title="统计"
        aria-label="统计"
      >
        <ChartNoAxesColumn className="h-[18px] w-[18px]" />
      </button>
      <span className="flex-1" />
      <button className="rail-btn" onClick={() => onOpenSettings("pet")} title="桌宠" aria-label="桌宠">
        <Cat className="h-[18px] w-[18px]" />
      </button>
      <button className="rail-btn" onClick={() => onOpenSettings("theme")} title="设置" aria-label="设置">
        <Settings2 className="h-[18px] w-[18px]" />
      </button>
    </nav>
  );
}
