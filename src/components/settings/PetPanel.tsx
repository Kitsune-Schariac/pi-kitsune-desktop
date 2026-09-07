import { useState } from "react";
import { usePetStore } from "../../store/pet";
import { Cat, FolderOpen, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

// 设置分区标题: 与 ThemePanel 同款 (mini 档 + mono + 大写 + faint)
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 font-mono text-mini font-semibold uppercase tracking-[0.09em] text-[var(--faint)]">
      {children}
    </h3>
  );
}

// 桌宠开关 + 角色选择 + 缩放 (设置页「桌宠」tab)
export function PetPanel() {
  const enabled = usePetStore((s) => s.enabled);
  const pets = usePetStore((s) => s.pets);
  const petId = usePetStore((s) => s.petId);
  const zoom = usePetStore((s) => s.zoom);
  const setEnabled = usePetStore((s) => s.setEnabled);
  const setPetId = usePetStore((s) => s.setPetId);
  const setZoom = usePetStore((s) => s.setZoom);
  const loadPets = usePetStore((s) => s.loadPets);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await loadPets();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <section>
        <SectionTitle>桌面宠物</SectionTitle>
        <p className="-mt-1 mb-3 text-body text-[var(--muted)]">
          一个置顶的小窗角色，跟着会话状态换动作：思考、执行工具、报错、待机。
        </p>
        <label className="flex cursor-pointer items-center gap-2.5 text-body text-[var(--fg)]">
          <input
            type="checkbox"
            checked={enabled}
            disabled={pets.length === 0}
            onChange={(e) => void setEnabled(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          启用桌宠
          {pets.length === 0 && (
            <span className="text-label text-[var(--faint)]">（没有可用的宠物包）</span>
          )}
        </label>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <SectionTitle>角色</SectionTitle>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-md border border-[var(--border-soft)] px-2 py-1 text-label text-[var(--muted)] transition duration-fast hover:border-[var(--border)] hover:text-[var(--fg)]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            刷新列表
          </button>
        </div>

        {pets.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--border-soft)] px-4 py-6 text-center">
            <Cat className="mx-auto mb-2 h-6 w-6 text-[var(--faint)]" />
            <p className="text-body text-[var(--muted)]">还没有宠物包</p>
            <p className="mt-1 text-label text-[var(--faint)]">
              把宠物包放进 <code className="font-mono">~/.pi-kitsune/pets/&lt;id&gt;/</code>
              ，每个目录含 pet.json 与精灵图
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {pets.map((p) => {
              const isActive = p.id === petId;
              return (
                <button
                  key={p.id}
                  onClick={() => setPetId(p.id)}
                  aria-pressed={isActive}
                  className={`rounded-md border px-3 py-2.5 text-left transition duration-fast ease-out ${
                    isActive
                      ? "border-[var(--accent)] ring-2 ring-[color-mix(in_oklch,var(--accent)_25%,transparent)]"
                      : "border-[var(--border-soft)] hover:border-[var(--border)]"
                  }`}
                  title={p.description || p.display_name}
                >
                  <div className="flex items-center gap-2">
                    <Cat className="h-4 w-4 shrink-0 text-[var(--muted)]" />
                    <span className="truncate text-body text-[var(--fg)]">{p.display_name}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-label text-[var(--faint)]">
                    {p.description || `${p.frame_width}×${p.frame_height}`}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>大小</SectionTitle>
        <label className="block">
          <div className="mb-1 flex items-center justify-between text-label text-[var(--muted)]">
            <span>缩放</span>
            <span className="tabular-nums text-[var(--fg)]">{zoom.toFixed(1)}x</span>
          </div>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full cursor-pointer accent-[var(--accent)]"
          />
        </label>
        <p className="mt-1.5 text-label text-[var(--faint)]">
          在桌宠上滚滚轮也能缩放；左键拖动移动位置，右键出菜单。
        </p>
      </section>

      <section>
        <button
          onClick={() => void invoke("open_pets_dir")}
          className="flex items-center gap-2 rounded-md border border-[var(--border-soft)] px-3 py-2 text-body text-[var(--muted)] transition duration-fast hover:border-[var(--border)] hover:text-[var(--fg)]"
        >
          <FolderOpen className="h-4 w-4" />
          打开宠物目录
        </button>
      </section>
    </div>
  );
}
