import { Check, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useThemeStore, type ThemeMode } from "../../store/theme";
import { Card, Section, SettingRow } from "../ui";

const MODES: { mode: ThemeMode; title: string; desc: string; icon: LucideIcon }[] = [
  { mode: "light", title: "日间", desc: "白底黑字", icon: Sun },
  { mode: "dark", title: "夜间", desc: "黑底白字", icon: Moon },
  { mode: "system", title: "跟随系统", desc: "随系统明暗切换", icon: Monitor },
];

/**
 * 界面缩略图: 根节点挂 data-base, 直接命中 index.css 里对应那组 token,
 * 不在 TS 里复制任何颜色。画的是真实布局的骨架 (侧栏 / 气泡 / AI 回复 / 输入卡)
 */
function Preview({ base }: { base: "light" | "dark" }) {
  return (
    <div data-base={base} className="flex h-full w-full bg-bg" aria-hidden>
      <div className="flex w-[26%] flex-col gap-2 border-r border-line bg-pane px-2 py-3">
        <i className="block h-[5px] w-3/4 rounded-full bg-fg-4/50" />
        <i className="block h-[10px] w-full rounded-[4px] bg-card shadow-sm" />
        <i className="block h-[5px] w-2/3 rounded-full bg-fg-4/40" />
        <i className="block h-[5px] w-4/5 rounded-full bg-fg-4/40" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 px-3 pt-3">
        <i className="block h-[10px] w-1/2 self-end rounded-full bg-[var(--bubble)]" />
        <div className="flex gap-2">
          <i className="block h-[10px] w-[10px] shrink-0 rounded-full bg-card shadow-[inset_0_0_0_1px_var(--line-2)]" />
          <div className="flex flex-1 flex-col gap-[5px] pt-[2px]">
            <i className="block h-[4px] w-full rounded-full bg-fg/60" />
            <i className="block h-[4px] w-5/6 rounded-full bg-fg/60" />
            <i className="block h-[12px] w-full rounded-[4px] border border-line bg-card shadow-sm" />
          </div>
        </div>
        <div className="mb-2 mt-auto flex h-[16px] items-center justify-end rounded-[6px] border border-line-2 bg-card px-[3px] shadow-sm">
          <i className="block h-[10px] w-[10px] rounded-full bg-accent" />
        </div>
      </div>
    </div>
  );
}

// 设置 · 外观: 日间 / 夜间 / 跟随系统 (三张可选卡片) + 字体说明
export function AppearancePanel() {
  const mode = useThemeStore((s) => s.mode);
  const resolved = useThemeStore((s) => s.resolved);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <div className="mx-auto max-w-[880px] space-y-8 px-8 py-8">
      <Section title="配色模式" desc="只有日间（白）与夜间（黑）两套配色，切换即时生效。">
        <div className="grid grid-cols-3 gap-4">
          {MODES.map(({ mode: m, title, desc, icon: Icon }) => {
            const on = m === mode;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={on}
                className={`group overflow-hidden rounded-lg border bg-card text-left shadow-md transition duration-fast ease-out ${
                  on ? "border-fg ring-1 ring-fg" : "border-line hover:border-line-2"
                }`}
              >
                <div className="relative h-28 w-full overflow-hidden">
                  {m === "system" ? (
                    <>
                      <div className="absolute inset-0">
                        <Preview base="light" />
                      </div>
                      {/* 右半边叠夜间, 斜切表示「看系统」 */}
                      <div className="absolute inset-0 [clip-path:polygon(62%_0,100%_0,100%_100%,38%_100%)]">
                        <Preview base="dark" />
                      </div>
                    </>
                  ) : (
                    <Preview base={m} />
                  )}
                </div>
                <div className="flex items-center gap-3 border-t border-line px-4 py-3">
                  <Icon className="h-4 w-4 shrink-0 text-fg-3" />
                  <div className="min-w-0 flex-1">
                    <div className="text-body font-medium text-fg">{title}</div>
                    <div className="text-label text-fg-4">
                      {m === "system" ? `${desc} · 当前${resolved === "dark" ? "夜间" : "日间"}` : desc}
                    </div>
                  </div>
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full transition duration-fast ${
                      on ? "bg-accent text-on-accent" : "border border-line-2"
                    }`}
                  >
                    {on && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="字体与字号" desc="全局统一，不随配色变化。">
        <Card>
          <SettingRow title="正文与标题" desc="内置 Noto Serif SC 衬线体，中英文同一套字形，无需另行安装">
            <span className="text-lead text-fg">永和九年 Aa</span>
          </SettingRow>
          <SettingRow title="代码与路径" desc="系统等宽字体 (Cascadia Mono / Consolas)">
            <span className="font-mono text-body text-fg-2">const pi = 3.14</span>
          </SettingRow>
          <SettingRow title="字号档位" desc="11 / 12 / 13 / 15 / 18 / 24 / 30，全站只用这七档">
            <span className="flex items-baseline gap-2 text-fg-2">
              <span className="text-meta">字</span>
              <span className="text-label">字</span>
              <span className="text-body">字</span>
              <span className="text-lead">字</span>
              <span className="text-head">字</span>
              <span className="text-num">字</span>
            </span>
          </SettingRow>
        </Card>
      </Section>
    </div>
  );
}
