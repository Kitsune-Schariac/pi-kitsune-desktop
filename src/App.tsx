import { useState } from "react";
import { useSessionStore } from "./store/session";
import { MessageList } from "./components/MessageList";
import { InputBar } from "./components/InputBar";
import { ModelPicker } from "./components/ModelPicker";
import { Terminal, FolderOpen, Loader2 } from "lucide-react";

export default function App() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const error = useSessionStore((s) => s.error);
  const cwd = useSessionStore((s) => s.cwd);
  const startSession = useSessionStore((s) => s.startSession);
  const stopSession = useSessionStore((s) => s.stopSession);
  const steeringQueue = useSessionStore((s) => s.steeringQueue);
  const followUpQueue = useSessionStore((s) => s.followUpQueue);

  const [cwdInput, setCwdInput] = useState("");
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    if (!cwdInput.trim()) return;
    setConnecting(true);
    try {
      await startSession(cwdInput.trim());
    } catch (e) {
      useSessionStore.setState({ error: String(e) });
    }
    setConnecting(false);
  };

  // 未连接: 连接面板 (选工作目录 → 启动 pi sidecar)
  if (!sessionId) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 text-neutral-100">
        <div className="w-full max-w-md space-y-6 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-8 shadow-2xl">
          <div className="flex items-center gap-3">
            <Terminal className="h-7 w-7 text-orange-400" />
            <div>
              <h1 className="text-xl font-semibold">Pi Kitsune</h1>
              <p className="text-sm text-neutral-500">pi coding agent 桌面端</p>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-neutral-400">工作目录</label>
            <input
              value={cwdInput}
              onChange={(e) => setCwdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              placeholder="C:\your\project"
              className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-orange-500/50"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            onClick={handleConnect}
            disabled={!cwdInput.trim() || connecting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-2.5 font-medium text-white transition hover:bg-orange-600 disabled:opacity-50"
          >
            {connecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FolderOpen className="h-4 w-4" />
            )}
            连接
          </button>
        </div>
      </div>
    );
  }

  // 已连接: 聊天界面
  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-orange-400" />
            <span className="font-medium">Pi Kitsune</span>
          </div>
          {isStreaming && (
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              思考中
            </span>
          )}
          <ModelPicker />
        </div>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          {(steeringQueue.length > 0 || followUpQueue.length > 0) && (
            <span
              className="rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400"
              title={`steer: ${steeringQueue.length}, followUp: ${followUpQueue.length}`}
            >
              队列 {steeringQueue.length + followUpQueue.length}
            </span>
          )}
          <span className="max-w-xs truncate" title={cwd}>
            {cwd}
          </span>
          <button
            onClick={stopSession}
            className="rounded px-2 py-1 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
          >
            断开
          </button>
        </div>
      </header>
      <MessageList />
      <InputBar />
      {error && (
        <div className="border-t border-red-900/50 bg-red-950/30 px-6 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}