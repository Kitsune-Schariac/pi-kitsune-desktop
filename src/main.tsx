import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import { PetWindow } from "./pet/PetWindow";
import { useSessionStore } from "./store/session";
import "./index.css";

// 同一份 bundle 服务两个窗口, 按 query 分流。桌宠窗口由 Rust 侧
// open_pet_window 以 index.html?window=pet 打开
const isPetWindow = new URLSearchParams(location.search).get("window") === "pet";
const root = ReactDOM.createRoot(document.getElementById("root")!);

if (isPetWindow) {
  // 桌宠窗口绝不注册 pi_event: Tauri 事件是广播的, 两个窗口都注册会让 session store 双跑
  root.render(
    <React.StrictMode>
      <PetWindow />
    </React.StrictMode>,
  );
} else {
  // 全局注册 pi 事件监听: 放在 React 组件树外, 只执行一次
  // 不放进 useEffect 是因为 React.StrictMode 开发模式会 mount→unmount→mount 双跑 effect,
  // 而 listen() 是 async, cleanup 时 listener 可能还没注册完导致泄漏,
  // 两个监听器会让每个 text_delta 被处理两次 → 流式文字翻倍重复
  listen<{ sessionId: string; event: Record<string, unknown> }>("pi_event", (e) => {
    useSessionStore.getState().handleEvent(e.payload);
  });

  // Rust 侧 LRU 淘汰 pi 进程时 emit: 标记 detached (entries 保留), 切回走 reattach 秒切
  listen<{ sessionId: string }>("session_evicted", (e) => {
    useSessionStore.getState().markDetached(e.payload.sessionId);
  });

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
