import { useEffect, useState } from "react";
import { X, BarChart3, Palette, Activity, Boxes, type LucideIcon } from "lucide-react";
import { TokenStatsPanel } from "./TokenStatsPanel";
import { ThemePanel } from "./ThemePanel";
import { BehaviorStatsPanel } from "./BehaviorStatsPanel";
import { ModelsPanel } from "./ModelsPanel";

type TabKey = "theme" | "stats" | "behavior" | "models";

// 导航项结构一致, 用数组 map 渲染; 描述文案同时用于侧栏第二行与内容区 header
// 图标与文案对齐改版稿设置导航 (setwin-nav-item); 页签大标题走 --fs-head 17px 档
const NAV_ITEMS: { key: TabKey; icon: LucideIcon; title: string; desc: string }[] = [
  { key: "theme", icon: Palette, title: "主题", desc: "皮肤 / 背景 / 不透明率" },
  { key: "stats", icon: BarChart3, title: "Token 统计", desc: "用量与成本分布" },
  { key: "behavior", icon: Activity, title: "行为统计", desc: "轮次 / 工具 / 思考占比" },
  { key: "models", icon: Boxes, title: "模型与供应商", desc: "models.json 的 provider 与模型" },
];

// 设置视图: 覆盖整个窗口的全屏界面 (不是浮在会话上的弹窗)
// 根容器用 absolute inset-0: App.tsx 里它渲染在 #app-root (fixed inset-0) 内部,
// 由 app-root 提供定位上下文, 铺满即等于切界面, 且天然盖住侧栏与会话区。
export function SettingsWindow({ onClose }: { onClose: () => void }) {
  // 当前分区
  const [tab, setTab] = useState<TabKey>("theme");

  // Esc 关闭 (卸载时移除监听)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = NAV_ITEMS.find((it) => it.key === tab)!;

  return (
    <div data-overlay className="absolute inset-0 z-50 flex view-in bg-[var(--surface-sunken)]">
      {/* 侧栏: 基座色承接整窗底色, 只靠右侧分隔线切出导航区 */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--border)]">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-soft)] px-5">
          <span className="text-title font-semibold text-[var(--fg)]">设置</span>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-[var(--faint)] transition duration-fast ease-out hover:bg-[var(--surface-base)] hover:text-[var(--fg)]"
            title="关闭 (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-2">
          {NAV_ITEMS.map(({ key, icon: Icon, title, desc }) => {
            const active = key === tab;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                aria-current={active ? "page" : undefined}
                className={`relative flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition duration-fast ease-out ${
                  active
                    ? "bg-[var(--sel-bg)]"
                    : "hover:bg-[color-mix(in_oklch,var(--surface-base)_55%,transparent)]"
                }`}
                title={desc}
              >
                {/* 选中指示条: 绝对定位在条目左缘, 不参与文字排版 */}
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-[var(--accent)]" />
                )}
                <Icon
                  className={`mt-1 h-4 w-4 shrink-0 ${
                    active ? "text-[var(--accent)]" : "text-[var(--faint)]"
                  }`}
                />
                <span className="min-w-0">
                  <span
                    className={`block truncate text-title ${
                      active ? "font-semibold text-[var(--fg)]" : "text-[var(--muted)]"
                    }`}
                  >
                    {title}
                  </span>
                  <span
                    className={`mt-1 block text-mini leading-snug ${
                      active
                        ? "text-[color-mix(in_oklch,var(--muted)_82%,var(--fg))]"
                        : "text-[var(--faint)]"
                    }`}
                  >
                    {desc}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>
        {/* 底部版本行 (改版稿 setwin-ver) */}
        <div className="shrink-0 border-t border-[var(--border-soft)] px-5 py-3 font-mono text-micro text-[var(--faint)]">
          Pi Kitsune · 设置
        </div>
      </aside>

      {/* 内容区: 内容底色比侧栏高一档, 两栏靠这一档色差分层 */}
      <div className="flex min-w-0 flex-1 flex-col bg-[var(--surface-base)]">
        {/* 页头: 大标题 head 档 + desc; 唯一大标题 (面板内不再自带 h2) */}
        <header className="flex h-16 shrink-0 flex-col justify-center gap-1 border-b border-[var(--border-soft)] px-6">
          <h2 className="text-head font-semibold text-[var(--fg)]">
            {current.title}
            <span className="ml-3 align-baseline text-label font-normal text-[var(--faint)]">
              {current.desc}
            </span>
          </h2>
        </header>
        {/* 主体不在这里滚动, 交给各面板自己决定 */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {/* key 换分区即重挂载: 触发一次轻量淡入, 同时让面板回到各自的初始滚动位置 */}
          <div key={tab} className="h-full view-in-soft">
            {tab === "theme" && (
              <div className="h-full overflow-y-auto">
                <ThemePanel />
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
            {/* ModelsPanel 自带全高两栏与内部滚动, 不套 padding/滚动容器 */}
            {tab === "models" && <ModelsPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
