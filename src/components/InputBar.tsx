import { useState } from "react";
import { useSessionStore } from "../store/session";
import { Send, Square } from "lucide-react";

export function InputBar() {
  const [text, setText] = useState("");
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const isStreaming = useSessionStore((s) => {
    const a = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
    return a?.isStreaming ?? false;
  });
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const abort = useSessionStore((s) => s.abort);

  const handleSend = () => {
    if (!text.trim() || isStreaming || !activeSessionId) return;
    sendPrompt(activeSessionId, text.trim());
    setText("");
  };

  const handleKey = (e: React.KeyboardEvent) => {
    // Enter 发送, Shift+Enter 换行
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-neutral-800 px-6 py-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder={isStreaming ? "等待回复…" : "输入消息, Enter 发送"}
          disabled={isStreaming}
          rows={2}
          className="flex-1 resize-none rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-orange-500/50 disabled:opacity-60"
        />
        {isStreaming ? (
          <button
            onClick={() => activeSessionId && abort(activeSessionId)}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-500/20 text-red-400 transition hover:bg-red-500/30"
            title="中止"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim()}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-500 text-white transition hover:bg-orange-600 disabled:opacity-40"
            title="发送"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}