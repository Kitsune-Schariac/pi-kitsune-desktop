// 舰队 stream 条目 hook: 订阅当前会话 entries, 纯派生 StreamEntry[]。
// 放 hook 不放 store (component-guidelines selector 模式 / design §5): session store 的
// 派生计算, 进 store 要管会话切换/消息重放的同步清理; hook + useMemo 天然跟随会话切换。
// 不加定时器: running 条目耗时由面板的 setNow tick 驱动 (v1 已有), hook 只算静态值
import { useMemo } from "react";
import { useSessionStore } from "../store/session";
import { deriveStreamEntries, type StreamEntry } from "../lib/fleetStream";

// 模块常量空数组: 无会话/无 entries 时返回同一引用, 避免 useMemo 每次产新数组触发重渲染
const EMPTY: StreamEntry[] = [];

export function useFleetStreamEntries(): StreamEntry[] {
  // 单 selector 精确到当前会话 entries: 只在 activeSession 的 entries 数组引用变化时触发,
  // 其他会话的 isStreaming/hasUnread 等字段变不会让本 hook 所在组件重渲染
  // (component-guidelines: selector 按需取值, 不订阅整个 sessions map)
  const entries = useSessionStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId]?.entries : undefined,
  );
  // entries 引用变才重算 (会话切换 / 消息流追加 / 回放都产生新 entries 数组引用)
  return useMemo(
    () => (entries ? deriveStreamEntries(entries) : EMPTY),
    [entries],
  );
}