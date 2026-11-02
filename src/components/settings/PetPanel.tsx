import { useState } from "react";
import { usePetStore } from "../../store/pet";
import { PetImport, TIER_LABEL } from "./PetImport";
import { Cat, Check, FolderOpen, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Badge, Button, Card, EmptyHint, Section, SettingRow, Slider, Switch } from "../ui";

// 设置 · 桌宠: 开关与活动 (设置行) / 角色 (可选卡片) / 导入
export function PetPanel() {
  const enabled = usePetStore((s) => s.enabled);
  const pets = usePetStore((s) => s.pets);
  const petId = usePetStore((s) => s.petId);
  const zoom = usePetStore((s) => s.zoom);
  const setEnabled = usePetStore((s) => s.setEnabled);
  const setPetId = usePetStore((s) => s.setPetId);
  const setZoom = usePetStore((s) => s.setZoom);
  const loadPets = usePetStore((s) => s.loadPets);
  const gravity = usePetStore((s) => s.gravity);
  const walk = usePetStore((s) => s.walk);
  const setGravity = usePetStore((s) => s.setGravity);
  const setWalk = usePetStore((s) => s.setWalk);
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
    <div className="mx-auto max-w-[880px] space-y-8 px-8 py-8">
      <Section title="桌面宠物" desc="一个置顶的小窗角色，跟着会话状态换动作：思考、执行工具、报错、待机。">
        <Card>
          <SettingRow
            title="启用桌宠"
            desc={pets.length === 0 ? "没有可用的宠物包，先在下方导入一个" : "关闭后不挂任何会话监听"}
          >
            <Switch
              checked={enabled}
              disabled={pets.length === 0}
              onChange={(v) => void setEnabled(v)}
              ariaLabel="启用桌宠"
            />
          </SettingRow>
          <SettingRow title="缩放" desc="在桌宠上滚动滚轮也能缩放；左键拖动移动位置，右键出菜单">
            <Slider
              className="w-56"
              min={0.5}
              max={3}
              step={0.1}
              value={zoom}
              onChange={setZoom}
              format={(v) => `${v.toFixed(1)}x`}
              ariaLabel="桌宠缩放"
            />
          </SettingRow>
          <SettingRow title="重力" desc="站在任务栏上，拖到半空松手会掉下来；关掉后放哪停哪">
            <Switch checked={gravity} onChange={setGravity} ariaLabel="重力" />
          </SettingRow>
          <SettingRow title="散步" desc="闲不住时在屏幕底边走来走去；觉得分心就关掉">
            <Switch checked={walk} onChange={setWalk} ariaLabel="散步" />
          </SettingRow>
        </Card>
      </Section>

      <Section
        title="角色"
        action={
          <>
            <Button size="sm" variant="subtle" onClick={() => void invoke("open_pets_dir")}>
              <FolderOpen className="h-[14px] w-[14px]" />
              打开目录
            </Button>
            <Button size="sm" variant="subtle" onClick={() => void onRefresh()} disabled={refreshing}>
              <RefreshCw className={`h-[14px] w-[14px] ${refreshing ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </>
        }
      >
        {pets.length === 0 ? (
          <EmptyHint icon={<Cat className="h-6 w-6" />} title="还没有宠物包">
            用下面的「导入宠物」选一个 zip 或文件夹，或直接放进
            <code className="mx-1 font-mono">~/.pi-kitsune/pets/&lt;id&gt;/</code>
          </EmptyHint>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {pets.map((p) => {
              const isActive = p.id === petId;
              return (
                <button
                  key={p.id}
                  onClick={() => setPetId(p.id)}
                  aria-pressed={isActive}
                  className={`flex items-start gap-3 rounded-lg border bg-card p-4 text-left shadow-md transition duration-fast ease-out ${
                    isActive ? "border-fg ring-1 ring-fg" : "border-line hover:border-line-2"
                  }`}
                  title={p.description || p.name}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-well shadow-[inset_0_0_0_1px_var(--line)]">
                    <Cat className="h-4 w-4 text-fg-3" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-body font-medium text-fg">{p.name}</span>
                      <Badge>{TIER_LABEL[p.tier]}</Badge>
                    </span>
                    <span className="mt-1 line-clamp-2 block text-label text-fg-4">
                      {p.description || `${p.frame_width}×${p.frame_height}`}
                    </span>
                    {p.missing.length > 0 && (
                      <span className="mt-1 block truncate text-label text-fg-4" title={p.missing.join("、")}>
                        缺：{p.missing.join("、")}
                      </span>
                    )}
                  </span>
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                      isActive ? "bg-accent text-on-accent" : "border border-line-2"
                    }`}
                  >
                    {isActive && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="导入宠物" desc="导入时会自动切帧、按脚底对齐、统一尺寸；旧版 Codex 宠物包也能直接导入。">
        <PetImport />
      </Section>
    </div>
  );
}
