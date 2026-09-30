// 「模型与供应商」页各区域共用的小件: 只放被两个以上区域用到的东西。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { CircleAlert } from "lucide-react";
import type { ProbeResult } from "../../../store/modelsConfig";

/** 行内文字链接 (收起 / 去挑选 / 在 JSON 中编辑 …) */
export const LINK =
  "whitespace-nowrap text-label text-[var(--accent)] underline-offset-[3px] hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline";

/** 常用接口类型 (本机 17 个供应商只用到前两种), 以分段控件平铺 */
export const API_MAIN = [
  { value: "openai-completions", label: "Chat Completions" },
  { value: "openai-responses", label: "Responses" },
  { value: "anthropic-messages", label: "Anthropic" },
] as const;

/** 其余合法取值收进「其他…」下拉; 与 models_config.rs is_valid_api 的全量枚举一致 */
export const API_MORE = [
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
] as const;

export const hostOf = (url: unknown): string => {
  if (typeof url !== "string" || !url.trim()) return "";
  try {
    return new URL(url.trim()).host;
  } catch {
    return "";
  }
};

/** 测试失败时给的修复建议: 后端只报事实 (error_kind + 状态码), 该怎么修由界面判断 */
export function probeHint(r: ProbeResult): string {
  switch (r.error_kind) {
    case "unsupported_api":
    case "unsupported_key":
      return "暂不支持测试, 可直接新建会话验证";
    case "invalid_url":
      return "写成 https://域名/v1 这样的形式";
    case "no_key":
      return "填写密钥; 用环境变量时要在启动桌面端之前设置好";
    case "invalid_header":
      return "检查密钥和「高级」里的请求头";
    case "http":
      if (r.status === 401 || r.status === 403) return "密钥无效, 或这个密钥没有访问该接口的权限";
      if (r.status === 404) return "检查 baseUrl 的路径, OpenAI 兼容接口一般到 /v1 为止";
      if (r.status === 429) return "请求过于频繁或额度已用完";
      if (r.status !== null && r.status >= 500) return "供应商服务端出错, 稍后再试";
      return "供应商拒绝了这次请求";
    case "timeout":
      return "网络不通, 或代理没有生效";
    case "connect": {
      const host = hostOf(r.url).replace(/:\d+$/, "");
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]"
        ? "本地转发服务可能没有启动"
        : "检查网络与代理设置";
    }
    case "parse":
      return "这个地址可能不是模型接口, 确认 baseUrl 指向 API 根路径";
    default:
      return "内部错误";
  }
}

const BADGE_TONE = {
  neutral: "border-[var(--line-2)] text-[var(--fg-3)]",
  accent: "border-[color-mix(in_oklch,var(--accent)_45%,transparent)] text-[var(--accent)]",
  warn: "border-[color-mix(in_oklch,var(--warn)_55%,transparent)] text-[var(--warn)]",
  err: "border-[color-mix(in_oklch,var(--err)_55%,transparent)] text-[var(--err)]",
} as const;

export function Badge({
  tone = "neutral",
  title,
  className = "",
  children,
}: {
  tone?: keyof typeof BADGE_TONE;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] border px-2 text-mini ${BADGE_TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** 28px 方形图标按钮; danger 悬停转红 (删除类) */
export function IconButton({
  title,
  danger = false,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--fg-3)] transition-colors duration-fast ease-out hover:bg-[var(--hover)] ${
        danger ? "hover:text-[var(--err)]" : "hover:text-[var(--fg)]"
      }`}
    >
      {children}
    </button>
  );
}

/** 字段下方的红字错误 */
export function FieldError({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-mini text-[var(--err)]">
      <CircleAlert className="h-3 w-3 shrink-0" />
      {children}
    </span>
  );
}

/** 容器自身宽度 (不是窗口宽度): 三栏 / 两栏、编辑器的标签列宽都按所在容器决定 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

// Esc 分层: 对话框 / 档位编辑 / 新增输入框各自能被 Esc 收起, 且只收最内层那个。
// 设置窗本身在 window 冒泡阶段监听 Esc 关窗; 这里在捕获阶段先拦下并停止传播,
// 否则按一次 Esc 会连设置窗一起关掉
const escStack: RefObject<() => void>[] = [];
function onEscCapture(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing || !escStack.length) return;
  e.stopPropagation();
  e.preventDefault();
  escStack[escStack.length - 1].current?.();
}

export function useEscapeLayer(active: boolean, onEscape: () => void) {
  const ref = useRef(onEscape);
  useEffect(() => {
    ref.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    escStack.push(ref);
    if (escStack.length === 1) window.addEventListener("keydown", onEscCapture, true);
    return () => {
      const i = escStack.lastIndexOf(ref);
      if (i >= 0) escStack.splice(i, 1);
      if (!escStack.length) window.removeEventListener("keydown", onEscCapture, true);
    };
  }, [active]);
}
