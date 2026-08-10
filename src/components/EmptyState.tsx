import { useState } from "react";
import { useProjectsStore } from "../store/projects";
import { FolderOpen } from "lucide-react";

// 按小时返回问候语 (早/午/下午/晚)
function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "早上好，今天想做什么?";
  if (h >= 11 && h < 14) return "中午好，有什么想琢磨的?";
  if (h >= 14 && h < 18) return "下午好，继续搞点事情?";
  return "晚上好，想聊点什么?";
}

// 项目选择小卡片: 渲染在输入卡容器底层 (absolute -top-3 bottom-0),
// 输入卡盖住卡片下部, 顶部露出 12px 的可点击项目条
export function ProjectCard({ project, onProjectChange }: {
  project: string;
  onProjectChange: (p: string) => void;
}) {
  const projects = useProjectsStore((s) => s.projects);
  const [open, setOpen] = useState(false);

  const displayName = project
    ? (projects.find((p) => p.path === project)?.display_name
       ?? project.split(/[\\/]/).filter(Boolean).pop() ?? project)
    : "选择项目";

  return (
    // 露出 35% 输入卡高: top 百分比相对输入卡容器 (wrapper) 高度, textarea 增高时自动跟随
    // 按钮绝对定位在露出区中部 (top 5% 卡片高 ≈ 单行输入卡时恰好居中)
    <div className="pointer-events-auto absolute inset-x-8 -top-[35%] bottom-0 z-0 rounded-2xl bg-neutral-100 shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        className="absolute left-4 top-[5%] inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] text-neutral-500 transition hover:shadow-md hover:text-primary-600"
        title="切换项目"
      >
        <FolderOpen className="h-3 w-3 shrink-0" />
        <span className="max-w-[140px] truncate">{displayName}</span>
      </button>
      {/* 项目列表弹层: 在卡片上方展开, z-50 压过输入卡 */}
      {open && (
        <div className="absolute bottom-full left-4 z-50 mb-1 max-h-56 w-[40%] overflow-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-xl">
          {projects.length === 0 ? (
            <div className="px-3 py-2 text-xs text-neutral-400">暂无项目</div>
          ) : (
            projects.map((p) => (
              <button
                key={p.path}
                onClick={() => { onProjectChange(p.path); setOpen(false); }}
                className={`block w-full truncate px-3 py-1.5 text-left text-xs transition hover:bg-neutral-100 ${
                  p.path === project ? "text-primary-600" : "text-neutral-600"
                }`}
              >
                {p.display_name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// 空状态: 居中问候语 (项目选择卡片由 App 注入 InputBar 底层)
export function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <h1 className="text-2xl font-semibold text-neutral-800">{greeting()}</h1>
      <p className="mt-1 text-sm text-neutral-400">选择项目，开始与 pi 对话</p>
    </div>
  );
}
