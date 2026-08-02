import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sparkles, Loader2, ChevronRight, ChevronDown, FileText } from "lucide-react";

interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

// Skill 面板: 已安装 skill 列表 (只读) + 查看 SKILL.md
export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillInfo | null>(null);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ skills: SkillInfo[] }>("list_skills_and_packages")
      .then((v) => setSkills(v.skills || []))
      .catch((e) => setError(String(e)));
  }, []);

  const openSkill = async (s: SkillInfo) => {
    setSelected(s);
    setContent(null);
    try {
      const res = await invoke<{ kind: "text"; content: string }>("read_file_for_context", {
        filePath: s.path,
      });
      setContent(res.content);
    } catch (e) {
      setContent(`读取失败: ${String(e)}`);
    }
  };

  if (error) return <p className="p-5 text-sm text-red-500">{error}</p>;
  if (!skills) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-neutral-400">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
      </div>
    );
  }

  return (
    <div className="p-5">
      {skills.length === 0 ? (
        <p className="rounded-lg bg-neutral-50 px-3 py-6 text-center text-sm text-neutral-400">
          未发现已安装的 skill
        </p>
      ) : (
        <ul className="space-y-2">
          {skills.map((s) => (
            <li key={s.path}>
              <button
                onClick={() => openSkill(s)}
                className={`w-full rounded-xl border p-3 text-left transition ${
                  selected?.path === s.path
                    ? "border-orange-300 bg-orange-50"
                    : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50"
                }`}
              >
                <span className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 shrink-0 text-orange-500" />
                  <span className="font-medium text-neutral-800">{s.name}</span>
                  {selected?.path === s.path ? (
                    <ChevronDown className="ml-auto h-4 w-4 text-neutral-400" />
                  ) : (
                    <ChevronRight className="ml-auto h-4 w-4 text-neutral-400" />
                  )}
                </span>
                {s.description && (
                  <span className="mt-1 block text-xs text-neutral-500">{s.description}</span>
                )}
              </button>
              {selected?.path === s.path && (
                <div className="mt-1 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                  <p className="mb-2 flex items-center gap-1 text-[11px] uppercase tracking-wide text-neutral-400">
                    <FileText className="h-3 w-3" />
                    SKILL.md
                  </p>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-600">
                    {content ?? "加载中…"}
                  </pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
