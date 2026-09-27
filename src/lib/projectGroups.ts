// 会话列表纯函数工具箱 (design §6): 临时目录判定、徽标缩写/色相、会话时间解析与分组。
// 全部无副作用, 与组件解耦, 便于单独验证。

/** Windows 路径归一: 小写 + 正斜杠统一为反斜杠 (AppData 判定要大小写不敏感) */
function normPath(p: string): string {
  return p.toLowerCase().replace(/\//g, "\\");
}

/** UUID 形态的显示名: pi 在系统临时目录起的会话, 项目名常是随机 UUID */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 临时目录判定 (design §6): 显示名是 UUID, 或路径落在 AppData\Local\Temp / AppData\Roaming 之下。
 * 这类项目不参与主列表拖拽排序, 收进底部「临时目录」折叠组。
 */
export function isTempProject(path: string, displayName: string): boolean {
  if (UUID_RE.test(displayName.trim())) return true;
  const norm = normPath(path);
  // 目标目录之下的路径与正好等于目标目录的路径都算 (后者不带尾分隔符)
  return (
    norm.includes("\\appdata\\local\\temp\\") ||
    norm.endsWith("\\appdata\\local\\temp") ||
    norm.includes("\\appdata\\roaming\\") ||
    norm.endsWith("\\appdata\\roaming")
  );
}

/** 项目名两字母缩写 (徽标): 按分隔符/驼峰切词取首字母, 单词不足两个时取前两字符 (原型 abbr 口径) */
export function abbr(name: string): string {
  const parts = name.split(/[-_\s]+|(?=[A-Z])/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

/** 项目名 → 稳定色相 (0–359): 同名永远同色相, 徽标配色由它派生 */
export function hue(name: string): number {
  return [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
}

/** 文件名时间戳 (2026-08-02T12-43-11-490Z, 非标准 ISO) → 毫秒; 解析失败 null */
export function parseSessionTs(ts: string): number | null {
  const iso = ts
    .replace(/-\d{3}Z$/, (m) => m.replace("-", "."))
    .replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, "$1T$2:$3:$4");
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** 最近视图分组 (本地自然日): 今天 / 本周 (近 7 天、非今天) / 更早 */
export function recentGroupLabel(ms: number): "今天" | "本周" | "更早" {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startOfToday) return "今天";
  if (ms >= startOfToday - 6 * 86400000) return "本周";
  return "更早";
}

/** 最近视图时间: 今天 → HH:mm, 其他 → MM-DD */
export function formatRecentTime(ms: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date(ms);
  if (recentGroupLabel(ms) === "今天") return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
