// Agent 运行时探测与新建会话偏好 store
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  AGENT_META,
  PI_CAPABILITIES,
  normalizeAgentKind,
  type AgentDescriptor,
  type AgentKind,
} from "../lib/agent";

const LAST_AGENT_KEY = "kitsune.lastAgent";

function readLastAgent(): AgentKind {
  try {
    return normalizeAgentKind(localStorage.getItem(LAST_AGENT_KEY));
  } catch {
    return "pi";
  }
}

/** 探测完成前的默认占位列表, 确保新建菜单立即可用 */
const FALLBACK_AGENTS: AgentDescriptor[] = [
  {
    kind: "pi",
    label: AGENT_META.pi.label,
    badge: AGENT_META.pi.badge,
    installed: true,
    version: null,
    implemented: true,
    available: true,
    reason: null,
    capabilities: PI_CAPABILITIES,
  },
  {
    kind: "claude",
    label: AGENT_META.claude.label,
    badge: AGENT_META.claude.badge,
    installed: false,
    version: null,
    implemented: true,
    available: false,
    reason: "正在探测…",
    capabilities: { ...PI_CAPABILITIES, steer: false, followUp: false, thinkingLevel: false, permissionModes: ["auto", "manual", "acceptEdits", "plan", "dontAsk", "bypassPermissions"], extensionUi: false, toolApproval: true, remoteCommands: false, sessionRename: false, fleetView: false, modelsEditor: false },
  },
  {
    kind: "agy",
    label: AGENT_META.agy.label,
    badge: AGENT_META.agy.badge,
    installed: false,
    version: null,
    implemented: true,
    available: false,
    reason: "正在探测…",
    capabilities: { ...PI_CAPABILITIES, steer: false, followUp: false, hotModelSwitch: false, thinkingLevel: false, extensionUi: false, toolApproval: true, remoteCommands: false, sessionRename: false, fleetView: false, modelsEditor: false },
  },
];

interface AgentsStore {
  agents: AgentDescriptor[];
  loaded: boolean;
  loading: boolean;
  /** 最近一次新建会话使用的 Agent (持久化, 新建菜单置顶并作为快捷默认) */
  lastAgent: AgentKind;
  loadAgents: () => Promise<void>;
  rememberAgent: (kind: AgentKind) => void;
}

export const useAgentsStore = create<AgentsStore>((set, get) => ({
  agents: FALLBACK_AGENTS,
  loaded: false,
  loading: false,
  lastAgent: readLastAgent(),

  loadAgents: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const list = await invoke<AgentDescriptor[]>("list_available_agents");
      if (Array.isArray(list) && list.length > 0) {
        // 若记住的上次 Agent 当前不可用, 保持列表真实状态但让上次记录回退到首个可用项
        const curLast = get().lastAgent;
        const lastOk = list.some((a) => a.kind === curLast && a.available);
        const firstAvail = list.find((a) => a.available)?.kind ?? "pi";
        set({
          agents: list,
          loaded: true,
          loading: false,
          lastAgent: lastOk ? curLast : firstAvail,
        });
        return;
      }
      set({ loaded: true, loading: false });
    } catch {
      set({ loaded: true, loading: false });
    }
  },

  rememberAgent: (kind) => {
    set({ lastAgent: kind });
    try {
      localStorage.setItem(LAST_AGENT_KEY, kind);
    } catch {
      /* ignore */
    }
  },
}));
