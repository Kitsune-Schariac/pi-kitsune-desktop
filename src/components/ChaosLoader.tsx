import { useMemo } from "react";

// 洛伦兹吸引子轨迹 (RK4 积分, x-z 平面投影 = 经典蝴蝶形)
// dt=0.01 + 1800 步: 轨迹绕两翼多圈形成丰满蝴蝶, 流动光沿轨道跑
function genLorenzPath(steps: number, dt: number, x0: number, y0: number, z0: number): string {
  const sigma = 10, rho = 28, beta = 8 / 3;
  const f = (x: number, y: number, z: number): [number, number, number] => [
    sigma * (y - x),
    x * (rho - z) - y,
    x * y - beta * z,
  ];
  let x = x0, y = y0, z = z0;
  const pts: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const [a1, b1, c1] = f(x, y, z);
    const [a2, b2, c2] = f(x + dt / 2 * a1, y + dt / 2 * b1, z + dt / 2 * c1);
    const [a3, b3, c3] = f(x + dt / 2 * a2, y + dt / 2 * b2, z + dt / 2 * c2);
    const [a4, b4, c4] = f(x + dt * a3, y + dt * b3, z + dt * c3);
    x += dt / 6 * (a1 + 2 * a2 + 2 * a3 + a4);
    y += dt / 6 * (b1 + 2 * b2 + 2 * b3 + b4);
    z += dt / 6 * (c1 + 2 * c2 + 2 * c3 + c4);
    pts.push([x, z]);
  }
  // 动态归一化到 viewBox 10-190 (留 10 边距, 自适应填满)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [px, pz] of pts) {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  const rx = (maxX - minX) || 1, rz = (maxZ - minZ) || 1;
  return pts.map(([px, pz], i) => {
    const sx = 10 + ((px - minX) / rx) * 180;
    const sy = 190 - ((pz - minZ) / rz) * 180;
    return `${i === 0 ? "M" : "L"}${sx.toFixed(1)} ${sy.toFixed(1)}`;
  }).join(" ");
}

// 两条轨迹不同初值 (吸引子形状都是蝴蝶, 细节不同) + 不同流动速度
// 颜色走语义状态变量 (--cyan / --violet): 10 套皮肤下均可读, 不锁死固定色
const TRACES = [
  { color: "var(--cyan)", dur: 3.0, x0: 0.1, y0: 0, z0: 0 },      // cyan
  { color: "var(--violet)", dur: 4.4, x0: -0.05, y0: 0.01, z0: 0 }, // violet
] as const;

export function ChaosLoader({ label = "加载中" }: { label?: string }) {
  // useMemo: 轨迹预计算一次, 不每帧重算 (1800 步 RK4 × 2 条, 毫秒级)
  const paths = useMemo(
    () => TRACES.map((t) => ({ ...t, d: genLorenzPath(1800, 0.01, t.x0, t.y0, t.z0) })),
    []
  );
  return (
    <div className="flex flex-col items-center gap-7">
      <div className="lorenz-wrap">
        <svg viewBox="0 0 200 200" className="lorenz-svg">
          <defs>
            <filter id="lorenz-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="1.4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {paths.map((p, i) => (
            <g key={i} filter="url(#lorenz-glow)">
              {/* 底层: 完整轨迹半透明, 显示蝴蝶全貌 */}
              <path d={p.d} stroke={p.color} strokeWidth={1} fill="none" opacity={0.13} />
              {/* 上层: 流动亮段沿轨迹跑 (pathLength=1 归一化, dashoffset 循环) */}
              <path
                d={p.d}
                stroke={p.color}
                strokeWidth={1.6}
                fill="none"
                strokeLinecap="round"
                pathLength={1}
                strokeDasharray="0.05 1"
                className="lorenz-flow"
                style={{ ["--dur" as string]: `${p.dur}s` }}
              />
            </g>
          ))}
        </svg>
      </div>
      <span className="text-mini tracking-[0.3em] text-[var(--faint)]">{label}</span>
    </div>
  );
}