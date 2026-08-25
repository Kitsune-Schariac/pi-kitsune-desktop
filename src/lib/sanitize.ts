// 终端专用渲染标记的检测与剥离
//
// pi 的扩展 (如 pi-kitsune-ui) 是照着 TUI 写的, notify 文本里会嵌 ANSI 转义序列上色、
// 用 Nerd Font 私用区码点当图标。终端会消费这些东西, WebView 不会:
// ESC 是不可见控制字符, 后面的 [1m / [38;2;0;255;255m 原样当文字显示, PUA 码点无字形变豆腐块。
//
// 判据只看结构 (有没有这两类标记), 不看文本语义 —— 按内容匹配某条特定提示太脆弱, 扩展一改就失效。

// CSI (ESC [ ... 终止符) | OSC (ESC ] ... BEL 或 ST) | 其余单字符 ESC 序列
const ANSI_PATTERN = "\\x1b\\[[0-9;?]*[ -\\/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[@-Z\\\\-_]";
// 私用区: BMP(E000-F8FF) + SPUA-A(F0000-FFFFD) + SPUA-B(100000-10FFFD)
// u flag 必加: Nerd Font 图标多在补充平面 (如 U+F0150), 不带 flag 会被当代理对拆开漏判
const PUA_PATTERN = "[\\uE000-\\uF8FF]|[\\u{F0000}-\\u{FFFFD}]|[\\u{100000}-\\u{10FFFD}]";

/** 文本是否携带终端渲染标记 (每次新建正则实例: 带 g flag 的实例复用会因 lastIndex 粘连误判) */
export function hasTerminalMarkup(text: string): boolean {
  return new RegExp(ANSI_PATTERN, "u").test(text) || new RegExp(PUA_PATTERN, "u").test(text);
}

/** 剥离终端标记, 并压缩因删字符留下的连续空格 */
export function stripTerminalMarkup(text: string): string {
  return text
    .replace(new RegExp(ANSI_PATTERN, "gu"), "")
    .replace(new RegExp(PUA_PATTERN, "gu"), "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
