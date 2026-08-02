import { useState } from "react";
import { useSessionStore } from "../store/session";
import { Cpu, ChevronDown, Brain } from "lucide-react";

// header 里的模型 + 思考级别切换器
export function ModelPicker() {
  const currentModel = useSessionStore((s) => s.currentModel);
  const availableModels = useSessionStore((s) => s.availableModels);
  const thinkingLevel = useSessionStore((s) => s.thinkingLevel);
  const availableThinkingLevels = useSessionStore((s) => s.availableThinkingLevels);
  const setModel = useSessionStore((s) => s.setModel);
  const setThinkingLevel = useSessionStore((s) => s.setThinkingLevel);

  const [modelOpen, setModelOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);

  return (
    <div className="flex items-center gap-1">
      {/* 模型选择 */}
      <div className="relative">
        <button
          onClick={() => setModelOpen(!modelOpen)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
        >
          <Cpu className="h-3.5 w-3.5" />
          <span className="max-w-[140px] truncate">
            {currentModel?.name || "未选择"}
          </span>
          <ChevronDown className="h-3 w-3" />
        </button>
        {modelOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-lg border border-neutral-800 bg-neutral-900 py-1 shadow-xl">
            {availableModels.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setModel(m.provider, m.id);
                  setModelOpen(false);
                }}
                className={`block w-full px-3 py-1.5 text-left text-xs transition hover:bg-neutral-800 ${
                  m.id === currentModel?.id
                    ? "text-orange-400"
                    : "text-neutral-300"
                }`}
              >
                <div className="font-medium">{m.name}</div>
                <div className="text-neutral-600">{m.provider}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* thinking level 选择 (仅当有多个级别时显示) */}
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