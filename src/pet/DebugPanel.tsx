// 桌宠大脑调试面板 (仅 dev 构建): 当前行为 / 内驱力 / 最近 10 分钟类别占比 / 时间倍率
//
// 画在画布左上角的透明区域里, 那里是点击穿透的, 所以面板只读; 开关和"时间 ×10"在右键菜单。
// 每秒拉一次 brain.debug() 重渲染 —— 透明窗重绘很贵, 但只在 dev 且面板开着时才有。
import { useEffect, useState, type RefObject } from "react";
import { BrainCircuit } from "lucide-react";
import type { Brain, BrainDebug } from "./brain";

const POLL_MS = 1000;

function Bar({ label, value, text }: { label: string; value: number; text: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 32px", alignItems: "center", gap: 6 }}>
      <span style={{ color: "var(--fg-2)" }}>{label}</span>
      <div style={{ height: 4, borderRadius: 2, background: "var(--line)" }}>
        <div
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`,
            height: "100%",
            borderRadius: 2,
            background: "var(--accent)",
          }}
        />
      </div>
      <span style={{ textAlign: "right" }}>{text}</span>
    </div>
  );
}

export function DebugPanel({ brainRef }: { brainRef: RefObject<Brain | null> }) {
  const [d, setD] = useState<BrainDebug | null>(null);

  useEffect(() => {
    const pull = () => setD(brainRef.current?.debug() ?? null);
    pull();
    const timer = window.setInterval(pull, POLL_MS);
    return () => window.clearInterval(timer);
  }, [brainRef]);

  if (!d) return null;
  const shares = Object.entries(d.shares).sort((a, b) => b[1] - a[1]);

  return (
    <div
      className="text-micro"
      style={{
        position: "absolute",
        left: 4,
        top: 4,
        width: 176,
        padding: "6px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 3,
        borderRadius: 8,
        background: "color-mix(in oklch, var(--bg) 90%, transparent)",
        color: "var(--fg)",
        border: "1px solid var(--line-2)",
        fontVariantNumeric: "tabular-nums",
        pointerEvents: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
        <BrainCircuit size={12} strokeWidth={1.75} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.action}
        </span>
        <span style={{ color: "var(--fg-2)", fontWeight: 400 }}>
          {d.loopsLeft === Infinity ? "∞" : `×${d.loopsLeft}`}
        </span>
      </div>
      <div style={{ color: "var(--fg-2)" }}>
        {d.category}
        {d.stack.length > 0 && ` · 栈 ${d.stack.join(" › ")}`}
        {d.timeScale !== 1 && ` · 时间 ×${d.timeScale}`}
      </div>
      <Bar label="精力" value={d.energy} text={d.energy.toFixed(2)} />
      <Bar label="无聊" value={d.boredom} text={d.boredom.toFixed(2)} />
      <div style={{ color: "var(--fg-2)", marginTop: 2 }}>近 10 分钟</div>
      {shares.map(([cat, v]) => (
        <Bar key={cat} label={cat} value={v} text={`${Math.round(v * 100)}%`} />
      ))}
    </div>
  );
}
