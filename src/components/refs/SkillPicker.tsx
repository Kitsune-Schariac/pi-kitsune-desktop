import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sparkles, Check, Loader2, AlertCircle } from "lucide-react";
import type { PathRef } from "../../lib/refs";

interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

// 技能引用: skill 有 SKILL.md 路径 → 走路径模式 (agent 自行读取), 与文件引用同一标记
export function SkillPicker({ onPick, onDone }: {
  onPick: (refs: PathRef[]) => void;
  onDone: () => void;
}) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ skills: SkillInfo[] }>("list_skills_and_packages")
      .then((v) => setSkills(v.skills || []))
      .catch((e) => setError(String(e)));
  }, []);

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const confirm = () => {
    if (!skills || selected.size === 0) return;
    onPick(
      skills
        .filter((s) => selected.has(s.path))
        .map((s) => ({ kind: "skill" as const, title: s.name, path: s.path }))
    );
    onDone();
  };

  if (error) return <p className="flex items-center gap-1 p-4 text-xs text-err"><AlertCircle className="h-4 w-4" />{error}</p>;

  return (
    <div className="flex h-72 flex-col">
      <div className="flex-1 overflow-auto rounded-md border border-line bg-popover p-2">
        {!skills ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-fg-4">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : skills.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-fg-4">
            未发现已安装的 skill
          </div>
        ) : (
          skills.map((s) => {
            const sel = selected.has(s.path);
            return (
              <button
                key={s.path}
                onClick={() => toggle(s.path)}
                className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition duration-fast ease-out ${
                  sel ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-hover"
                }`}
                title={s.description}
              >
                {sel ? (
                  <Check className="h-4 w-4 shrink-0 text-accent" />
                ) : (
                  <Sparkles className="h-4 w-4 shrink-0 text-fg-4" />
                )}
                <span className="truncate">{s.name}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-fg-4">已选 {selected.size} 个技能</span>
        <button
          onClick={confirm}
          disabled={selected.size === 0}
          className="rounded-md bg-accent px-3 py-2 text-xs text-on-accent transition duration-fast ease-out hover:bg-[color-mix(in_oklch,var(--accent)_88%,black)] disabled:opacity-40"
        >
          添加引用
        </button>
      </div>
    </div>
  );
}
