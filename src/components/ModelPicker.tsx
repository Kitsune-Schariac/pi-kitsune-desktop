import { useMemo, useState } from "react";
import { useSessionStore } from "../store/session";
import { Cpu, ChevronDown, Brain, Layers } from "lucide-react";

// header 里的 provider → model 两级选择 + thinking level 切换
export function ModelPicker() {
  const currentModel = useSessionStore((s) => s.currentModel);
  const availableModels = useSessionStore((s) => s.availableModels);
  const thinkingLevel = useSessionStore((s) => s.thinkingLevel);
  const availableThinkingLevels = useSessionStore((s) => s.availableThinkingLevels);
  const setModel = useSessionStore((s) => s.setModel);
  const setThinkingLevel = useSessionStore((s) => s.setThinkingLevel);

  // 从模型列表提取唯一 provider (去重)
  const providers = useMemo(
    () => [...new Set(availableModels.map((m) => m.provider))],
    [availableModels]
  );

  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  // 本地选中的 provider, 默认回退到当前模型的 provider
  const [selProvider, setSelProvider] = useState<string | null>(null);

  const activeProvider = selProvider ?? currentModel?.provider ?? "";
  const providerModels = availableModels.filter(
    (m) => m.provider === activeProvider
  );

  return (
    <div className="flex items-center gap-1">
      {/* ① provider 选择 */}
      <div className="relative">
        <button
          onClick={() => setProviderOpen(!providerOpen)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
        >
          <Layers className="h-3.5 w-3.5" />
          <span className="max-w-[100px] truncate">
            {activeProvider || "选 Provider"}
          </span>
          <ChevronDown className="h-3 w-3" />
        </button>
        {providerOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 rounded-lg border border-neutral-800 bg-neutral-900 py-1 shadow-xl">
            {providers.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setSelProvider(p);
                  setProviderOpen(false);
                }}
                className={`block w-full px-3 py-1.5 text-left text-xs transition hover:bg-neutral-800 ${
                  p === activeProvider ? "text-orange-400" : "text-neutral-300"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ② model 选择 (受 provider 过滤) */}
      <div className="relative">
        <button
          onClick={() => setModelOpen(!modelOpen)}
          disabled={!activeProvider}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
        >
          <Cpu className="h-3.5 w-3.5" />
          <span className="max-w-[120px] truncate">
            {currentModel?.name || "选 Model"}
          </span>
          <ChevronDown className="h-3 w-3" />
        </button>
        {modelOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-lg border border-neutral-800 bg-neutral-900 py-1 shadow-xl">
            {providerModels.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setModel(m.provider, m.id);
                  setModelOpen(false);
                }}
                className={`block w-full px-3 py-1.5 text-left text-xs transition hover:bg-neutral-800 ${
                  m.id === currentModel?.id ? "text-orange-400" : "text-neutral-300"
                }`}
              >
                {m.name}
              </button>
            ))}
            {providerModels.length === 0 && (
              <div className="px-3 py-2 text-xs text-neutral-600">
                该 provider 下无模型
              </div>
            )}
          </div>
        )}
      </div>

      {/* ③ thinking level 选择 (仅当有多个级别时显示) */}
      {availableThinkingLevels.length > 1 && (
        <div className="relative">
          <button
            onClick={() => setLevelOpen(!levelOpen)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs uppercase text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300"
          >
            <Brain className="h-3 w-3" />
            {thinkingLevel}
            <ChevronDown className="h-3 w-3" />
          </button>
          {levelOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 rounded-lg border border-neutral-800 bg-neutral-900 py-1 shadow-xl">
              {availableThinkingLevels.map((lv) => (
                <button
                  key={lv}
                  onClick={() => {
                    setThinkingLevel(lv);
                    setLevelOpen(false);
                  }}
                  className={`block w-full px-3 py-1 text-left text-xs uppercase transition hover:bg-neutral-800 ${
                    lv === thinkingLevel ? "text-orange-400" : "text-neutral-300"
                  }`}
                >
                  {lv}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}