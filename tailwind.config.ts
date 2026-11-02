import type { Config } from "tailwindcss";

// 设计 token 的 Tailwind 映射。颜色值只在 index.css 的日间 / 夜间两组变量里定义,
// 这里只做 class → var 的映射, 组件里不写任何字面颜色。
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    // 字号 7 档 (与 index.css 的 --fs-* 同值)。非 extend 覆盖: 没列出的档位不生成, 越界 class 构建即失效。
    // meta 元信息/角标 · label 标签/次要文字 · body 界面主力 (控件/列表) · lead 阅读正文/卡片标题 ·
    // head 页面与分区大标题 · num 统计数字 · display 空状态问候/花费
    fontSize: {
      // 字距随字号变化 (与 SF Pro 的字距表同向): 小字略放开保清晰, 大字收紧显精致
      meta: ["11px", { lineHeight: "1.5", letterSpacing: "0.01em" }],
      label: ["12px", { lineHeight: "1.5", letterSpacing: "0.005em" }],
      body: ["13px", { lineHeight: "1.55", letterSpacing: "0" }],
      lead: ["15px", { lineHeight: "1.65", letterSpacing: "-0.006em" }],
      head: ["18px", { lineHeight: "1.4", letterSpacing: "-0.012em" }],
      num: ["24px", { lineHeight: "1.2", letterSpacing: "-0.02em" }],
      display: ["30px", { lineHeight: "1.2", letterSpacing: "-0.022em" }],
    },
    // 间距阶: 4px 网格整档 (覆盖掉 Tailwind 默认的 .5 半档)
    spacing: {
      0: "0px",
      1: "4px",
      2: "8px",
      3: "12px",
      4: "16px",
      5: "20px",
      6: "24px",
      7: "28px",
      8: "32px",
      9: "36px",
      10: "40px",
      11: "44px",
      12: "48px",
      14: "56px",
      16: "64px",
      20: "80px",
      24: "96px",
      28: "112px",
      32: "128px",
      36: "144px",
      40: "160px",
      44: "176px",
      48: "192px",
      52: "208px",
      56: "224px",
      60: "240px",
      64: "256px",
      72: "288px",
      80: "320px",
      96: "384px",
    },
    // 字体只有两套: 界面无衬线 (苹果式) / 代码等宽, 值在 index.css 的 --f-ui / --f-mono
    fontFamily: {
      sans: ["var(--f-ui)"],
      mono: ["var(--f-mono)"],
    },
    // 圆角: 控件 10 / 卡片 16 / 大卡与弹窗 20 / 输入卡 24; 嵌套时内圆角 = 外圆角 − 内边距
    borderRadius: {
      none: "0px",
      DEFAULT: "8px",
      sm: "8px",
      md: "10px",
      lg: "16px",
      xl: "20px",
      "2xl": "24px",
      full: "9999px",
    },
    extend: {
      colors: {
        // 语义 token: color-mix 包一层让 /50 这类透明度修饰符继续可用
        bg: "color-mix(in srgb, var(--bg) calc(<alpha-value> * 100%), transparent)",
        rail: "color-mix(in srgb, var(--rail) calc(<alpha-value> * 100%), transparent)",
        pane: "color-mix(in srgb, var(--pane) calc(<alpha-value> * 100%), transparent)",
        card: "color-mix(in srgb, var(--card) calc(<alpha-value> * 100%), transparent)",
        raise: "color-mix(in srgb, var(--raise) calc(<alpha-value> * 100%), transparent)",
        popover: "color-mix(in srgb, var(--popover) calc(<alpha-value> * 100%), transparent)",
        well: "color-mix(in srgb, var(--well) calc(<alpha-value> * 100%), transparent)",
        hover: "color-mix(in srgb, var(--hover) calc(<alpha-value> * 100%), transparent)",
        line: "color-mix(in srgb, var(--line) calc(<alpha-value> * 100%), transparent)",
        // 浮起表面的外轮廓: 比分隔线更淡, 主要靠阴影出层次, 边缘才显得软
        edge: "color-mix(in srgb, var(--edge) calc(<alpha-value> * 100%), transparent)",
        "line-2": "color-mix(in srgb, var(--line-2) calc(<alpha-value> * 100%), transparent)",
        fg: "color-mix(in srgb, var(--fg) calc(<alpha-value> * 100%), transparent)",
        "fg-2": "color-mix(in srgb, var(--fg-2) calc(<alpha-value> * 100%), transparent)",
        "fg-3": "color-mix(in srgb, var(--fg-3) calc(<alpha-value> * 100%), transparent)",
        "fg-4": "color-mix(in srgb, var(--fg-4) calc(<alpha-value> * 100%), transparent)",
        accent: "color-mix(in srgb, var(--accent) calc(<alpha-value> * 100%), transparent)",
        "accent-2": "color-mix(in srgb, var(--accent-2) calc(<alpha-value> * 100%), transparent)",
        "accent-soft": "color-mix(in srgb, var(--accent-soft) calc(<alpha-value> * 100%), transparent)",
        "on-accent": "color-mix(in srgb, var(--on-accent) calc(<alpha-value> * 100%), transparent)",
        ok: "color-mix(in srgb, var(--ok) calc(<alpha-value> * 100%), transparent)",
        err: "color-mix(in srgb, var(--err) calc(<alpha-value> * 100%), transparent)",
        warn: "color-mix(in srgb, var(--warn) calc(<alpha-value> * 100%), transparent)",
      },
      // 动效阶: 显式时长 + 曲线
      transitionDuration: {
        fast: "120ms",
        base: "200ms",
        slow: "320ms",
      },
      transitionTimingFunction: {
        swift: "cubic-bezier(0.32, 0.72, 0, 1)",
        entrance: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      // 阴影三档: sm 控件 / md 卡片 / lg 浮层 (值在 index.css, 日间柔影、夜间靠描边)
      boxShadow: {
        DEFAULT: "var(--shadow-md)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
    },
  },
  plugins: [],
} satisfies Config;
