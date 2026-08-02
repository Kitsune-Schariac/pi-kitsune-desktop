import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../store/session";
import { Coins, Gauge, MessageSquare, Loader2, RefreshCw } from "lucide-react";

// 设置面板: token 使用统计 (get_session_stats) + 默认偏好展示
export function SettingsPanel() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tokenStats = useSessionStore((s) => {
    const a = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
    return a?.tokenStats ?? null;
  });
  const contextUsage = useSessionStore((s) => {
    const a = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
    return a?.contextUsage ?? null;
  });
  const loadSessionStats = useSessionStore((s) => s.loadSessionStats);
  const [defaults, setDefaults] = useState<{ defaultProvider: string; defaultModel: string; defaultThinkingLevel: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 默认偏好: Rust 读 settings.json (随 skill/package 命令返回)
    invoke("list_skills_and_packages")
      .then((v) => {
        const d = (v as { defaults?: typeof defaults }).defaults;
        if (d) setDefaults(d);
      })
      .catch(() => {});
  }, []);

  const refresh = async () => {
    if (!activeSessionId) return;
    setLoading(true);
    await loadSessionStats(activeSessionId);
    setLoading(false);
  };

  const percent = contextUsage?.percent ?? null;
  const tokens = tokenStats?.tokens;

  return (
    <div className="space-y-6 p-5">
      {/* Token 使用统计 */}
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-neutral-700">
          <Coins className="h-4 w-4 text-orange-500" />
          Token 使用统计
          <button
            onClick={refresh}
            disabled={!activeSessionId || loading}
            className="ml-auto rounded p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40"
            title="刷新"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </h3>
        {!activeSessionId ? (
          <p className="rounded-lg bg-neutral-50 px-3 py-4 text-center text-sm text-neutral-400">
            暂无活动会话，统计将在打开会话后显示
          </p>
        ) : (
          <div className="space-y-3">
            {/* 上下文占用 */}
            <div className="rounded-xl border border-neutral-200 p-3">
              <div className="mb-1.5 flex items-center justify-between text-xs text-neutral-500">
                <span className="flex items-center gap-1">
                  <Gauge className="h-3.5 w-3.5" />
                  上下文占用
                </span>
                <span className="tabular-nums">
                  {percent === null ? "--" : `${Math.round(percent)}%`}
                  {contextUsage && (
                    <span className="ml-1 text-neutral-400">
                      ({Math.round((contextUsage.tokens ?? 0) / 1000)}k / {Math.round(contextUsage.contextWindow / 1000)}k)
                    </span>
                  )}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-neutral-200">
                <div
                  className={`h-full rounded-full transition-all ${percent !== null && percent > 85 ? "bg-red-500" : "bg-orange-500"}`}
                  style={{ width: percent === null ? "0%" : `${Math.min(100, percent)}%` }}
                />
              </div>
            </div>

            {/* Token 明细 */}
            {tokens && (
              <div className="rounded-xl border border-neutral-200 p-3 text-xs">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1 font-medium text-neutral-600">
                    <MessageSquare className="h-3.5 w-3.5" />
                    累计用量 (当前会话)
                  </span>
                  <span className="rounded-full bg-orange-50 px-2 py-0.5 font-semibold text-orange-600">
                    {tokens.total.toLocaleString()} tokens
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-y-1.5 text-neutral-500">
                  <div className="flex justify-between"><dt>输入</dt><dd className="tabular-nums">{tokens.input.toLocaleString()}</dd></div>
                  <div className="flex justify-between"><dt>输出</dt><dd className="tabular-nums">{tokens.output.toLocaleString()}</dd></div>
                  <div className="flex justify-between"><dt>缓存读</dt><dd className="tabular-nums">{tokens.cacheRead.toLocaleString()}</dd></div>
                  <div className="flex justify-between"><dt>缓存写</dt><dd className="tabular-nums">{tokens.cacheWrite.toLocaleString()}</dd></div>
                </dl>
                {tokenStats && (
                  <div className="mt-2 flex justify-between border-t border-neutral-100 pt-2 text-neutral-600">
                    <span>估算成本</span>
                    <span className="font-medium tabular-nums">${tokenStats.cost.toFixed(4)}</span>
                  </div>
                )}
                {tokenStats && (
                  <div className="mt-1 flex justify-between text-neutral-400">
                    <span>消息数</span>
                    <span className="tabular-nums">
                      用户 {tokenStats.userMessages} / 助手 {tokenStats.assistantMessages} / 共 {tokenStats.totalMessages}
                    </span>
                  </div>
                )}
              </div>
            )}
            {!tokens && (
              <p className="rounded-lg bg-neutral-50 px-3 py-4 text-center text-sm text-neutral-400">
                暂无统计 (需模型可用)
              </p>
            )}
          </div>
        )}
      </section>

      {/* 默认偏好 (只读, 来自 pi settings.json) */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-neutral-700">默认偏好</h3>
        {defaults ? (
          <dl className="space-y-2 rounded-xl border border-neutral-200 p-3 text-xs text-neutral-600">
            <div className="flex justify-between">
              <dt className="text-neutral-400">默认 Provider</dt>
              <dd className="font-medium">{defaults.defaultProvider || "--"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-400">默认 Model</dt>
              <dd className="font-medium">{defaults.defaultModel || "--"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-400">默认 Thinking</dt>
              <dd className="font-medium">{defaults.defaultThinkingLevel || "--"}</dd>
            </div>
          </dl>
        ) : (
          <p className="rounded-lg bg-neutral-50 px-3 py-4 text-center text-sm text-neutral-400">
            读取 pi 配置中…
          </p>
        )}
      </section>
    </div>
  );
}
