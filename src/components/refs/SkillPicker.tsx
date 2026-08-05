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

  if (error) return <p className="flex items-center gap-1 p-4 text-xs text-red-500"><AlertCircle className="h-3.5 w-3.5" />{error}</p>;

  return (
    <div className="flex h-72 flex-col">
      <div className="flex-1 overflow-auto rounded-lg border border-neutral-200 bg-white p-1.5">
        {!skills ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : skills.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-neutral-300">
            未发现已安装的 skill
          </div>
        ) : (
          skills.map((s) => {
            const sel = selected.has(s.path);
            return (
              <button
                key={s.path}
                onClick={() => toggle(s.path)}
                className={`mb-0.5 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition ${
                  sel ? "bg-orange-50 text-orange-700" : "text-neutral-600 hover:bg-neutral-100"
                }`}
                title={s.description}
              >
                {sel ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                )}
                <span className="truncate">{s.name}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-neutral-400">已选 {selected.size} 个技能</span>
        <button
          onClick={confirm}
          disabled={selected.size === 0}
          className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs text-white transition hover:bg-orange-600 disabled:opacity-40"
        >
          添加引用
        </button>
      </div>
    </div>
  );
}
