// / 命令面板数据模型: 本地白名单 + pi 透传命令类型
// 本地命令是客户端动作 (UI 反馈即时), 透传命令以 send_prompt 原样发出由 pi 执行

import type { LucideIcon } from "lucide-react";
import { Plus, Cpu, Brain, Square, Sparkles, Package } from "lucide-react";

/** 本地白名单命令静态定义 (执行器由 InputBar 按 name 分发) */
export interface LocalCommandDef {
  name: string;
  description: string;
  icon: LucideIcon;
}

export const LOCAL_COMMANDS: LocalCommandDef[] = [
  { name: "new", description: "新建会话", icon: Plus },
  { name: "model", description: "切换模型", icon: Cpu },
  { name: "thinking", description: "思考级别", icon: Brain },
  { name: "stop", description: "中止运行", icon: Square },
  { name: "skills", description: "打开技能面板", icon: Sparkles },
  { name: "packages", description: "打开包面板", icon: Package },
];

/** pi 侧透传命令 (get_commands RPC 返回, name 无前导斜杠) */
export interface PassthroughCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

/** 面板执行回调的统一载荷: source 区分本地与透传来源 */
export interface PaletteCommand {
  name: string;
  source: "local" | "extension" | "prompt" | "skill";
}
