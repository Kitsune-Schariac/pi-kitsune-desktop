import { useMemo } from "react";
import { MousePointerClick } from "lucide-react";
import { useSessionStore } from "../../store/session";
import { useModelsConfigStore, isObj, providerOf } from "../../store/modelsConfig";
import {
  analyzeActions,
  analyzeContext,
  analyzeCost,
  analyzeTokens,
  type ModelPricing,
} from "../../lib/telemetry";
import { ContextStrip } from "./overview/ContextStrip";
import { TokenStrip } from "./overview/TokenStrip";
import { CostStrip } from "./overview/CostStrip";
import { ActionStrip } from "./overview/ActionStrip";
import { BackgroundTasksStrip } from "./overview/BackgroundTasksStrip";

/** 从已加载的 models.json 中按 provider + modelId 提取单价 (未打开设置窗时安静返回 null) */
function lookupModelPricing(
  doc: Record<string, unknown> | null,
  provider?: string,
  modelId?: string,
): ModelPricing | null {
  if (!doc || !provider || !modelId) return null;
  const prov = providerOf(doc, provider);
  const models = Array.isArray(prov.models) ? prov.models : [];
  for (const m of models) {
    if (!isObj(m) || m.id !== modelId) continue;
    if (!isObj(m.cost)) return null;
    const { input, output, cacheRead, cacheWrite } = m.cost;
    if (
      typeof input === "number" &&
      typeof output === "number" &&
      typeof cacheRead === "number" &&
      typeof cacheWrite === "number"
    ) {
      return { input, output, cacheRead, cacheWrite };
    }
  }
  return null;
}

/**
 * 检查器「概览」页签的精密遥测面板 (未选中步骤时显示)。
 * 五大剖析带: 后台任务 · 上下文解剖 · Token 构成 · 费用解析 · 执行动作解析。
 */
export function SessionOverview() {
  const tokenStats = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.tokenStats ?? null : null;
  });
  const liveCostDetail = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.liveCostDetail ?? null : null;
  });
  const contextUsage = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.contextUsage ?? null : null;
  });
  const currentModel = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.currentModel ?? null : null;
  });
  const thinkingLevel = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.thinkingLevel ?? "medium" : "medium";
  });
  const turnStats = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.turnStats ?? null : null;
  });
  const entries = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.entries : undefined;
  });
  const modelsDoc = useModelsConfigStore((s) => s.doc);

  const pricing = useMemo(
    () => lookupModelPricing(modelsDoc, currentModel?.provider, currentModel?.id),
    [modelsDoc, currentModel?.provider, currentModel?.id],
  );

  const contextData = useMemo(
    () => analyzeContext(contextUsage, entries),
    [contextUsage, entries],
  );
  const tokenData = useMemo(
    () => analyzeTokens(tokenStats, turnStats),
    [tokenStats, turnStats],
  );
  const costData = useMemo(
    () => analyzeCost(tokenStats, turnStats, liveCostDetail ?? tokenStats?.costDetail ?? null, pricing),
    [tokenStats, turnStats, liveCostDetail, pricing],
  );
  const actionData = useMemo(() => analyzeActions(entries), [entries]);

  return (
    <section className="ov">
      <div className="space-y-3">
        <BackgroundTasksStrip />
        <ContextStrip data={contextData} />
        <TokenStrip data={tokenData} />
        <CostStrip
          data={costData}
          turns={tokenStats?.userMessages ?? 0}
          totalMessages={tokenStats?.totalMessages ?? 0}
        />
        <ActionStrip
          data={actionData}
          model={currentModel}
          thinkingLevel={thinkingLevel}
          speed={turnStats?.speed ?? null}
        />
      </div>

      <p className="ov-hint">
        <MousePointerClick className="h-3 w-3" />
        点时间线上任意一步，在这里查看命令、输出与 diff
      </p>
    </section>
  );
}
