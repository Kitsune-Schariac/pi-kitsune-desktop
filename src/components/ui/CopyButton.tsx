import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy } from "lucide-react";

// 一键复制钮 (AI 回复 / 用户提问 / 代码块 / 查看器路径共用)。
// 走 clipboard-manager 插件而非 navigator.clipboard: 后者在 WebView2 里会弹剪贴板权限询问
export function CopyButton({
  text,
  title = "复制",
  className = "",
}: {
  /** 函数形式: 点击时才取值 (如路径需先解析), 避免每次渲染都算 */
  text: string | (() => string | Promise<string>);
  title?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async (e: React.MouseEvent) => {
    // 按钮常嵌在可点击区域里 (路径链接 / 折叠头), 不让点击冒泡触发外层行为
    e.stopPropagation();
    try {
      await writeText(typeof text === "function" ? await text() : text);
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), 1500);
    } catch (err) {
      // 复制失败不打断阅读 (如剪贴板被占用), 没有错误展示位, 记日志即可
      console.error("复制失败", err);
    }
  };

  const Icon = done ? Check : Copy;
  return (
    <button
      type="button"
      onClick={(e) => void onClick(e)}
      title={done ? "已复制" : title}
      aria-label={title}
      className={`copy-btn ${done ? "done" : ""} ${className}`}
    >
      <Icon className="h-[14px] w-[14px]" />
    </button>
  );
}
