import { useState } from "react";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { FolderOpen, Loader2, Sparkles } from "lucide-react";

// 按小时返回问候语 (早/午/下午/晚)
function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "早上好，今天想做什么?";
  if (h >= 11 && h < 14) return "中午好，有什么想琢磨的?";
  if (h >= 14 && h < 18) return "下午好，继续搞点事情?";
  return "晚上好，想聊点什么?";
}

// 空状态: 居中问候 + 项目选择器 (新建会话归属) + 下方对话框
export function EmptyState({ project, onProjectChange }: {
  project: string;
  onProjectChange: (p: string) => void;
}) {
  const projects = useProjectsStore((s) => s.projects);
  const startSession = useSessionStore((s) => s.startSession);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleNew = async () => {
    if (!project || starting) return;
    setStarting(true);
    setError(null);
    try {
      await startSession(project);
    } catch (e) {
      setError(String(e));
    }
    setStarting(false);
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="mb-6 flex flex-col items-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-500 text-white shadow-lg shadow-orange-500/25">
          <Sparkles className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-semibold text-neutral-800">{greeting()}</h1>
        <p className="mt-1 text-sm text-neutral-400">选择项目，开始与 pi 对话</p>
      </div>

      {/* 项目选择器 */}
      <div className="flex w-full max-w-md items-center gap-2">
        <div className="relative flex-1">
          <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <select
            value={project}
            onChange={(e) => onProjectChange(e.target.value)}
            className="w-full appearance-none rounded-xl border border-neutral-200 bg-white py-2.5 pl-9 pr-8 text-sm text-neutral-700 shadow-sm outline-none transition hover:border-neutral-300 focus:border-orange-400"
          >
            <option value="">选择项目…</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.display_name}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={handleNew}
          disabled={!project || starting}
          className="flex items-center gap-1.5 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-orange-600 disabled:opacity-40"
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          新建会话
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
    </div>
  );
}
