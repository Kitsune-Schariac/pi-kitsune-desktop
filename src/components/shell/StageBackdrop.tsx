import { useThemeStore } from "../../store/theme";

/**
 * 舞台背景层: 仅壁纸皮肤 (data-style="stage") 渲染。
 * fixed 铺满、z-index 0, 由 #app-root 的 z-10 把外壳压在上层;
 * 玻璃感不使用 backdrop-filter (WebView2 有内容消失 bug), 由暗幕 + 面板高不透明度填充实现。
 */
export function StageBackdrop() {
  const activeHasBg = useThemeStore((s) => s.activeHasBg);
  if (!activeHasBg) return null;
  return (
    <>
      <div className="stage-wall" aria-hidden />
      <div className="stage-scrim" aria-hidden />
    </>
  );
}
