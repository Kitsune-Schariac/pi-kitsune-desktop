import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import { useSessionStore } from "./store/session";
import "./index.css";

// 全局注册 pi 事件监听: 放在 React 组件树外, 只执行一次
// 不放进 useEffect 是因为 React.StrictMode 开发模式会 mount→unmount→mount 双跑 effect,
// 而 listen() 是 async, cleanup 时 listener 可能还没注册完导致泄漏,
// 两个监听器会让每个 text_delta 被处理两次 → 流式文字翻倍重复
listen<{ sessionId: string; event: Record<string, unknown> }>("pi_event", (e) => {
  useSessionStore.getState().handleEvent(e.payload.event);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);