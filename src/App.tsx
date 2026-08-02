import { useState } from "react";
import { useSessionStore } from "./store/session";
import { MessageList } from "./components/MessageList";
import { InputBar } from "./components/InputBar";
import { ModelPicker } from "./components/ModelPicker";
import { SessionTabs } from "./components/SessionTabs";
import { Terminal, FolderOpen, Loader2 } from "lucide-react";

export default function App() {
  const sessions = useSessionStore((s) => s.sessions);
  const sessionOrder = useSessionStore((s) => s.sessionOrder);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const startSession = useSessionStore((s) => s.startSession);
  const stopSession = useSessionStore((s) => s.stopSession);

  const active = activeSessionId ? sessions[activeSessionId] : null;
  const hasSession = sessionOrder.length > 0;

  const [cwdInput, setCwdInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const handleConnect = async () => {
    if (!cwdInput.trim()) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await startSession(cwdInput.trim());
      setCwdInput("");
      setShowConnect(false);
    } catch (e) {
      setConnectError(String(e));
    }
    setConnecting(false);
  };

  // 连接面板 (无 session 全屏 / 有 session 时作为覆盖层)
  const connectForm = (
    <div className="w-full max-w-md space-y-6 rounded-2xl border border-neutral-800 bg-neutral-900/90 p-8 shadow-2xl">
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
      {connectError && <p className="text-sm text-red-400">{connectError}</p>}
      <div className="flex gap-3">
        <button
          onClick={handleConnect}
          disabled={!cwdInput.trim() || connecting}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-2.5 font-medium text-white transition hover:bg-orange-600 disabled:opacity-50"
        >
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
          连接
        </button>
        {hasSession && (
          <button
            onClick={() => setShowConnect(false)}
            className="rounded-lg border border-neutral-800 px-4 py-2.5 text-sm text-neutral-400 transition hover:text-neutral-200"
          >
            取消
          </button>
        )}
      </div>
    </div>
  );

  // 无 session: 全屏连接面板
  if (!hasSession) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 text-neutral-100">
        {connectForm}
      </div>
    );
  }

  // 有 session: tabs + 聊天 + 可选连接覆盖层
  const queueLen = (active?.steeringQueue.length || 0) + (active?.followUpQueue.length || 0);
  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-neutral-100">
      <SessionTabs onNew={() => setShowConnect(true)} />
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-orange-400" />
            <span className="font-medium">Pi Kitsune</span>
          </div>
          {active?.isStreaming && (
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              思考中
            </span>
          )}
          <ModelPicker />
        </div>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          {queueLen > 0 && (
            <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">
              队列 {queueLen}
            </span>
          )}
          <span className="max-w-xs truncate" title={active?.cwd ?? ""}>
            {active?.cwd}
          </span>
          {activeSessionId && (
            <button
              onClick={() => stopSession(activeSessionId)}
              className="rounded px-2 py-1 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
            >
              断开
            </button>
          )}
        </div>
      </header>
      <MessageList />
      <InputBar />
      {active?.error && (
        <div className="border-t border-red-900/50 bg-red-950/30 px-6 py-2 text-sm text-red-400">
          {active.error}
        </div>
      )}
      {showConnect && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-950/80">
          {connectForm}
        </div>
      )}
    </div>
  );
}