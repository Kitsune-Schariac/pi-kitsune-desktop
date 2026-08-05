// / 命令面板: 本地白名单 (客户端动作) + pi 透传命令 (扩展/技能/模板, 经 get_commands 动态拉取)
// 键盘路由由 InputBar 统一处理, 本组件经 ref 暴露 move/confirm; 执行回调统一为 PaletteCommand

import { useEffect, useImperativeHandle, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal, Loader2, AlertCircle, X, type LucideIcon } from "lucide-react";
import { LOCAL_COMMANDS, type PaletteCommand, type PassthroughCommand } from "../lib/commands";

export interface CommandPaletteHandle {
  move: (delta: number) => void;
  confirm: () => void;
}

interface PaletteItem {
  key: string;
  name: string;
  description: string;
  icon?: LucideIcon;
  source: PaletteCommand["source"];
  disabled?: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  extension: "扩展",
  prompt: "模板",
  skill: "技能",
};

export function CommandPalette({ sessionId, streaming, query, onExecute, onClose, ref }: {
  sessionId: string | null;
  streaming: boolean;
  query: string;
  onExecute: (cmd: PaletteCommand) => void;
  onClose: () => void;
  ref?: React.Ref<CommandPaletteHandle>;
}) {
  const [remote, setRemote] = useState<PassthroughCommand[] | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  // 透传命令: 首次打开拉取一次, 失败降级为仅本地命令 (提示条告知); 无会话不拉取
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    invoke<{ commands: PassthroughCommand[] }>("get_commands", { sessionId })
      .then((v) => { if (!cancelled) setRemote(v.commands || []); })
      .catch((e) => { if (!cancelled) setRemoteError(String(e)); });
    return () => { cancelled = true; };
  }, [sessionId]);

  // 合并候选: 本地白名单在前 (保持静态顺序), 透传按名称排序在后; stop 空闲时置灰
  const items = useMemo<PaletteItem[]>(() => {
    const locals: PaletteItem[] = LOCAL_COMMANDS.map((c) => ({
      key: `local-${c.name}`,
      name: c.name,
      description: c.description,
      icon: c.icon,
      source: "local",
      disabled: c.name === "stop" && !streaming,
    }));
    const remotes: PaletteItem[] = (remote ?? [])
      .map((c) => ({
        key: `remote-${c.source}-${c.name}`,
        name: c.name,
        description: c.description ?? "",
        source: c.source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...locals, ...remotes];
  }, [remote, streaming]);

  // 过滤: 查询词首词匹配命令名 (支持 /cmd 参数输入), 全串匹配描述
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return items;
    const fw = q.split(/\s+/)[0] ?? "";
    return items.filter((it) => it.name.includes(fw) || it.description.includes(q));
  }, [items, query]);

  // 过滤词/数据变化后选中回到顶部
  useEffect(() => { setActive(0); }, [query, remote, streaming]);

  const confirmPick = (it: PaletteItem) => {
    if (it.disabled) return;
    onExecute({ name: it.name, source: it.source });
  };

  useImperativeHandle(ref, () => ({
    // 上下导航跳过置灰项 (如空闲时的 stop)
    move: (delta: number) => {
      const n = filtered.length;
      if (n === 0) return;
      let idx = active;
      for (let step = 0; step < n; step++) {
        idx = (idx + delta + n) % n;
        if (!filtered[idx].disabled) { setActive(idx); return; }
      }
    },
    confirm: () => {
      const c = filtered[active];
      if (c) confirmPick(c);
    },
  }), [filtered, active, onExecute]);

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-[420px] rounded-xl border border-neutral-200 bg-white p-2 shadow-xl">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-[11px] text-neutral-400">命令 · ↑↓ 选择, Enter 执行</span>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-neutral-400 transition hover:bg-neutral-100"
          title="关闭 (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {remoteError && (
        <p className="mx-2 mb-1 flex items-center gap-1 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-500">
          <AlertCircle className="h-3 w-3 shrink-0" />
          pi 命令加载失败, 仅显示本地命令
        </p>
      )}
      {!sessionId && !remoteError && (
        <p className="mx-2 mb-1 flex items-center gap-1 rounded-lg bg-neutral-50 px-2 py-1.5 text-[11px] text-neutral-400">
          打开会话后可用 pi 扩展/技能/模板命令
        </p>
      )}

      <div className="max-h-72 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex h-24 items-center justify-center gap-2 text-xs text-neutral-300">
            {remote === null && sessionId ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> 加载 pi 命令…
              </>
            ) : (
              "没有匹配的命令"
            )}
          </div>
        ) : (
          filtered.map((it, i) => {
            const sel = i === active;
            const Icon = it.icon ?? Terminal;
            return (
              <button
                key={it.key}
                onClick={() => confirmPick(it)}
                onMouseEnter={() => setActive(i)}
                disabled={it.disabled}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                  it.disabled
                    ? "opacity-40"
                    : sel
                      ? "bg-orange-50"
                      : "hover:bg-neutral-100"
                }`}
                title={it.description}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${it.source === "local" ? "text-neutral-400" : "text-orange-400"}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-medium ${sel ? "text-orange-700" : "text-neutral-700"}`}>
                    /{it.name}
                  </span>
                  <span className="block truncate text-[10px] text-neutral-400">{it.description}</span>
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${
                    it.source === "local"
                      ? "bg-neutral-100 text-neutral-500"
                      : "bg-blue-50 text-blue-500"
                  }`}
                  title={it.source === "local" ? "本地命令" : `pi ${SOURCE_LABEL[it.source] ?? it.source} 命令`}
                >
                  {it.source === "local" ? "本地" : "pi"}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
