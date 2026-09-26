import { useMemo, type CSSProperties } from "react";
import { useProjectsStore, pathEq, type SessionNode } from "../store/projects";
import { useSessionStore } from "../store/session";
import { abbr, hue, parseSessionTs, formatRecentTime } from "../lib/projectGroups";

// 按小时返回问候语 (早/午/下午/晚)
function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "早上好，今天想做什么?";
  if (h >= 11 && h < 14) return "中午好，有什么想琢磨的?";
  if (h >= 14 && h < 18) return "下午好，继续搞点事情?";
  return "晚上好，想聊点什么?";
}

// 「最近会话」排序键: 文件 mtime 优先, 缺失回退文件名时间戳 (与 ProjectList 最近视图同一口径)
function sessionRank(s: SessionNode): number {
  return s.mtime_ms ?? parseSessionTs(s.timestamp) ?? 0;
}

/**
 * 空状态 (design §8): 工坊 = 居中问候 + 最近会话快捷入口; 舞台 = 问候落文字列, 右侧留给角色。
 * 形态差异由 index.css 的 .empty-* 按 data-style 分支表达。
 */
export function EmptyState() {
  const projects = useProjectsStore((s) => s.projects);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionOrder = useSessionStore((s) => s.sessionOrder);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const startSession = useSessionStore((s) => s.startSession);
  const reattachSession = useSessionStore((s) => s.reattachSession);

  // 最近会话: 全量磁盘会话按修改时间降序取 5 条。
  // 打开中未落盘的会话不进这里 —— 有活跃会话时渲染的是时间线, 空状态不出现
  const recent = useMemo(
    () =>
      projects
        .flatMap((p) => p.sessions.map((s) => ({ project: p, session: s })))
        .filter(({ session }) => sessionRank(session) > 0)
        .sort((a, b) => sessionRank(b.session) - sessionRank(a.session))
        .slice(0, 5),
    [projects],
  );

  // 打开方式与 ProjectList.handleOpenSession 一致 (该函数未导出, 这里复刻同一调用序列):
  // 已打开 → 切活跃 (+ detached 后台 reattach); 未打开 → startSession 带 sessionPath 载入历史
  const openSession = async (projectPath: string, s: SessionNode) => {
    const openId = sessionOrder.find((sid) => pathEq(sessions[sid]?.sessionPath, s.session_path));
    if (openId) {
      setActiveSession(openId);
      if (sessions[openId]?.detached) {
        void reattachSession(openId, projectPath, s.session_path);
      }
      return;
    }
    try {
      await startSession(projectPath, { sessionPath: s.session_path });
    } catch (e) {
      console.error("加载会话失败", e);
    }
  };

  return (
    <div className="empty-root">
      <h1 className="empty-greeting">{greeting()}</h1>
      <p className="empty-sub mt-3 text-ui text-fg-3">选择项目，开始与 pi 对话</p>
      {recent.length > 0 && (
        <div className="empty-recent">
          {/* 分组小标题复用会话列表最近视图的 .sess-grp (两风格形态已有分支) */}
          <div className="sess-grp">最近会话</div>
          {recent.map(({ project, session }) => {
            const title = session.preview.split("\n")[0].trim() || session.file_name;
            return (
              <button
                key={session.session_path}
                onClick={() => void openSession(project.path, session)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-body text-fg-2 transition duration-fast ease-out hover:bg-hover hover:text-fg"
                title={`${project.display_name} · ${title}`}
              >
                <span
                  className="sess-badge"
                  // CSS 自定义属性 --h 不在 CSSProperties 类型定义内, 双重断言绕过
                  style={{ "--h": String(hue(project.display_name)) } as unknown as CSSProperties}
                  aria-hidden
                >
                  {abbr(project.display_name)}
                </span>
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span className="shrink-0 font-mono text-mini tabular-nums text-fg-4">
                  {formatRecentTime(sessionRank(session))}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
