import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MessageSquare, User, Bot, Loader2, ChevronRight, Check, AlertCircle,
} from "lucide-react";
import type { InlineRef } from "../../lib/refs";
import { mapHistoryEntries, type ChatEntry } from "../../store/session";

interface SessionNode {
  file_name: string;
  session_path: string;
  timestamp: string;
  session_id: string;
  preview: string;
}
interface ProjectNode {
  path: string;
  display_name: string;
  sessions: SessionNode[];
}

// 内联引用内容截断: 单条消息引用 token 可控, 超长只取头部
const MAX_REF_CHARS = 4000;

function entryRefText(e: ChatEntry): string {
  if (e.kind !== "message") return "";
  const head = e.thinking ? `(思考摘要省略)\n` : "";
  const text = e.text ?? "";
  return head + text;
}

// 历史会话消息引用: 选会话 → 选消息 (单选) → InlineRef (会话 jsonl 是私有格式, 走内容模式)
export function SessionPicker({ onPick, onDone }: {
  onPick: (refs: InlineRef[]) => void;
  onDone: () => void;
}) {
  const [projects, setProjects] = useState<ProjectNode[] | null>(null);
  const [selProject, setSelProject] = useState<ProjectNode | null>(null);
  const [selSession, setSelSession] = useState<SessionNode | null>(null);
  const [entries, setEntries] = useState<ChatEntry[] | null>(null);
  const [selMsg, setSelMsg] = useState<ChatEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ProjectNode[]>("list_projects_and_sessions")
      .then(setProjects)
      .catch((e) => setError(String(e)));
  }, []);

  const openSession = async (p: ProjectNode, s: SessionNode) => {
    setSelProject(p);
    setSelSession(s);
    setSelMsg(null);
    setEntries(null);
    try {
      const raw = await invoke<unknown[]>("read_session_entries_public", { sessionPath: s.session_path });
      setEntries(mapHistoryEntries(raw).filter((e) => e.kind === "message" && e.text));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const confirm = () => {
    if (!selProject || !selSession || !selMsg) return;
    const content = entryRefText(selMsg);
    if (!content) return;
    onPick([{
      kind: "session",
      title: `${selProject.display_name} · ${selMsg.role === "user" ? "用户" : "助手"}消息`,
      content: content.length > MAX_REF_CHARS
        ? content.slice(0, MAX_REF_CHARS) + "\n…(引用内容过长已截断)"
        : content,
    }]);
    onDone();
  };

  return (
    <div className="flex h-72 gap-2">
      {/* 左: 会话列表 */}
      <div className="w-1/2 overflow-auto rounded-md border border-neutral-200 bg-panel p-2">
        {!projects ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : (
          projects.map((p) => (
            <div key={p.path} className="mb-1">
              <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
                {p.display_name}
              </div>
              {p.sessions.map((s) => (
                <button
                  key={s.session_path}
                  onClick={() => openSession(p, s)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition duration-fast ease-out ${
                    selSession?.session_path === s.session_path
                      ? "bg-primary-50 text-primary-700"
                      : "text-neutral-600 hover:bg-neutral-100"
                  }`}
                  title={s.preview}
                >
                  <MessageSquare className="h-4 w-4 shrink-0 text-neutral-400" />
                  <span className="truncate">{s.preview || s.file_name}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
      {/* 右: 消息列表 (单选) */}
      <div className="flex w-1/2 flex-col">
        <div className="flex-1 overflow-auto rounded-md border border-neutral-200 bg-panel p-2">
          {!selSession ? (
            <div className="flex h-full items-center justify-center text-xs text-neutral-300">
              先选一个会话
            </div>
          ) : !entries ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" /> 读取消息…
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-neutral-300">
              无消息
            </div>
          ) : (
            entries.map((e) => {
              const sel = selMsg?.id === e.id;
              return (
                <button
                  key={e.id}
                  onClick={() => setSelMsg(sel ? null : e)}
                  className={`mb-1 flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs transition duration-fast ease-out ${
                    sel ? "bg-primary-50 text-primary-700" : "text-neutral-600 hover:bg-neutral-100"
                  }`}
                >
                  {e.role === "user" ? (
                    <User className="mt-1 h-3 w-3 shrink-0 text-neutral-400" />
                  ) : (
                    <Bot className="mt-1 h-3 w-3 shrink-0 text-neutral-400" />
                  )}
                  <span className="line-clamp-2">
                    {e.role === "user" ? "用户" : "助手"}: {e.text?.slice(0, 120)}
                  </span>
                  {sel && <Check className="mt-1 h-3 w-3 shrink-0 text-primary-500" />}
                </button>
              );
            })
          )}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-neutral-400">
            {selMsg ? "已选 1 条消息" : "点击消息单选"}
          </span>
          <button
            onClick={confirm}
            disabled={!selMsg}
            className="flex items-center gap-1 rounded-md bg-primary-500 px-3 py-2 text-xs text-white transition duration-fast ease-out hover:bg-primary-600 disabled:opacity-40"
          >
            <ChevronRight className="h-3 w-3" />
            添加引用
          </button>
        </div>
      </div>
      {error && (
        <p className="absolute bottom-14 left-3 flex items-center gap-1 text-xs text-red-500">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
    </div>
  );
}
