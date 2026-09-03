import type { Config } from "tailwindcss";

// 主题色: primary 色阶由 index.css 的 CSS 变量驱动, 换主题只需改 :root 里一组变量
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    // 字号 9 档 (语义名 + 同值旧别名): 语义名供改版新 UI 使用, 旧别名保 364 处存量 class 零改动。
    // 非 extend 覆盖: 未列出的档位 (如已删除的 lg=18px) 不再生成, 越界 class 构建即失效
    fontSize: {
      micro: ["10px", { lineHeight: "1.4", letterSpacing: "0.01em" }],
      mini: ["11px", { lineHeight: "1.45", letterSpacing: "0.005em" }],
      label: ["12px", { lineHeight: "1.5", letterSpacing: "0.002em" }],
      body: ["13px", { lineHeight: "1.55", letterSpacing: "0" }],
      ui: ["14px", { lineHeight: "1.6", letterSpacing: "-0.003em" }],
      title: ["15px", { lineHeight: "1.65", letterSpacing: "-0.006em" }],
      head: ["17px", { lineHeight: "1.45", letterSpacing: "-0.01em" }],
      num: ["20px", { lineHeight: "1.2", letterSpacing: "-0.014em" }],
      hero: ["24px", { lineHeight: "1.25", letterSpacing: "-0.018em" }],
      // 旧别名 (与语义档同值, 引用同组配置): xs=mini / sm=body / base=title / 2xl=hero
      xs: ["11px", { lineHeight: "1.45", letterSpacing: "0.005em" }],
      sm: ["13px", { lineHeight: "1.55", letterSpacing: "0" }],
      base: ["15px", { lineHeight: "1.65", letterSpacing: "-0.006em" }],
      "2xl": ["24px", { lineHeight: "1.25", letterSpacing: "-0.018em" }],
    },
    // 间距阶: 4px 网格整档 (保留 Tailwind 默认 0-96 全部整档, 覆盖掉 .5 半档)
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
    borderRadius: {
      sm: "4px",
      md: "8px",
      full: "9999px",
    },
    extend: {
      colors: {
        primary: {
          50: "color-mix(in oklch, var(--primary-50) calc(<alpha-value> * 100%), transparent)",
          100: "color-mix(in oklch, var(--primary-100) calc(<alpha-value> * 100%), transparent)",
          200: "color-mix(in oklch, var(--primary-200) calc(<alpha-value> * 100%), transparent)",
          300: "color-mix(in oklch, var(--primary-300) calc(<alpha-value> * 100%), transparent)",
          400: "color-mix(in oklch, var(--primary-400) calc(<alpha-value> * 100%), transparent)",
          500: "color-mix(in oklch, var(--primary-500) calc(<alpha-value> * 100%), transparent)",
          600: "color-mix(in oklch, var(--primary-600) calc(<alpha-value> * 100%), transparent)",
          700: "color-mix(in oklch, var(--primary-700) calc(<alpha-value> * 100%), transparent)",
          800: "color-mix(in oklch, var(--primary-800) calc(<alpha-value> * 100%), transparent)",
          900: "color-mix(in oklch, var(--primary-900) calc(<alpha-value> * 100%), transparent)",
        },
        // 中性色阶变量化: 类名不用改, 底层值随主题方向切换 (浅色值 = 原 Tailwind 默认值)
        neutral: {
          50: "color-mix(in oklch, var(--neutral-50) calc(<alpha-value> * 100%), transparent)",
          100: "color-mix(in oklch, var(--neutral-100) calc(<alpha-value> * 100%), transparent)",
          200: "color-mix(in oklch, var(--neutral-200) calc(<alpha-value> * 100%), transparent)",
          300: "color-mix(in oklch, var(--neutral-300) calc(<alpha-value> * 100%), transparent)",
          400: "color-mix(in oklch, var(--neutral-400) calc(<alpha-value> * 100%), transparent)",
          500: "color-mix(in oklch, var(--neutral-500) calc(<alpha-value> * 100%), transparent)",
          600: "color-mix(in oklch, var(--neutral-600) calc(<alpha-value> * 100%), transparent)",
          700: "color-mix(in oklch, var(--neutral-700) calc(<alpha-value> * 100%), transparent)",
          800: "color-mix(in oklch, var(--neutral-800) calc(<alpha-value> * 100%), transparent)",
          900: "color-mix(in oklch, var(--neutral-900) calc(<alpha-value> * 100%), transparent)",
          950: "color-mix(in oklch, var(--neutral-950) calc(<alpha-value> * 100%), transparent)",
        },
        // 浮层/卡片实心底 (popup/弹窗/设置窗口), 皮肤可覆盖 --panel
        panel: "color-mix(in oklch, var(--panel) calc(<alpha-value> * 100%), transparent)",
      },
      // 动效阶: 显式时长 + 曲线 (裸 transition 必须补全, 见 design 表四)
      transitionDuration: {
        fast: "120ms",
        base: "200ms",
        slow: "320ms",
      },
      transitionTimingFunction: {
        swift: "cubic-bezier(0.32, 0.72, 0, 1)",
        entrance: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      // 阴影: 双层带色相, 值定义在 index.css 的 --shadow-* 变量 (随皮肤切换)
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
    },
  },
  plugins: [],
} satisfies Config;
