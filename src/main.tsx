import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import { useSessionStore } from "./store/session";
import { applyAccent, useThemeStore } from "./store/theme";
import type { AgentEventPayload } from "./lib/agent";
// 拉丁字形用内置 Inter (可变字重, 接近 SF Pro), 按 unicode-range 分片只加载用到的那片;
// 中文不打包, 走系统黑体 (苹方 / 微软雅黑 UI), 见 index.css --f-ui
import "@fontsource-variable/inter";
import "./index.css";

// 首帧就写好明暗与强调色 (store 构造时已读出持久化偏好), 避免先闪一帧白底 / 墨色
document.documentElement.dataset.base = useThemeStore.getState().resolved;
applyAccent(useThemeStore.getState().accent);

// 全局注册统一 Agent 事件监听: 放在 React 组件树外, 只执行一次
// (不放进 useEffect 是因为 React.StrictMode 会双跑, async listen 易泄漏导致流式文字重复)
listen<AgentEventPayload>("agent_event", (e) => {
  useSessionStore.getState().handleEvent(e.payload);
});

// Rust 侧 LRU 淘汰子进程时 emit: 标记 detached (entries 保留), 切回走 reattach 秒切
listen<{ sessionId: string }>("session_evicted", (e) => {
  useSessionStore.getState().markDetached(e.payload.sessionId);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
