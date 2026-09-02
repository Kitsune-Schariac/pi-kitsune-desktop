import type { Config } from "tailwindcss";

// 主题色: primary 色阶由 index.css 的 CSS 变量驱动, 换主题只需改 :root 里一组变量
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "rgb(var(--primary-50) / <alpha-value>)",
          100: "rgb(var(--primary-100) / <alpha-value>)",
          200: "rgb(var(--primary-200) / <alpha-value>)",
          300: "rgb(var(--primary-300) / <alpha-value>)",
          400: "rgb(var(--primary-400) / <alpha-value>)",
          500: "rgb(var(--primary-500) / <alpha-value>)",
          600: "rgb(var(--primary-600) / <alpha-value>)",
          700: "rgb(var(--primary-700) / <alpha-value>)",
          800: "rgb(var(--primary-800) / <alpha-value>)",
          900: "rgb(var(--primary-900) / <alpha-value>)",
        },
        // 中性色阶变量化: 类名不用改, 底层值随主题方向切换 (浅色值 = 原 Tailwind 默认值)
        neutral: {
          50: "rgb(var(--neutral-50) / <alpha-value>)",
          100: "rgb(var(--neutral-100) / <alpha-value>)",
          200: "rgb(var(--neutral-200) / <alpha-value>)",
          300: "rgb(var(--neutral-300) / <alpha-value>)",
          400: "rgb(var(--neutral-400) / <alpha-value>)",
          500: "rgb(var(--neutral-500) / <alpha-value>)",
          600: "rgb(var(--neutral-600) / <alpha-value>)",
          700: "rgb(var(--neutral-700) / <alpha-value>)",
          800: "rgb(var(--neutral-800) / <alpha-value>)",
          900: "rgb(var(--neutral-900) / <alpha-value>)",
          950: "rgb(var(--neutral-950) / <alpha-value>)",
        },
        // 浮层/卡片实心底 (popup/弹窗/设置窗口), 皮肤可覆盖 --panel
        panel: "rgb(var(--panel) / <alpha-value>)",
      },
      // 字号阶: 覆盖默认档数值 (存量类名自动落位), 删除的档位不在此列 → class 不再生成
      fontSize: {
        xs: ["11px", { lineHeight: "1.45", letterSpacing: "0.005em" }],
        sm: ["13px", { lineHeight: "1.55", letterSpacing: "0" }],
        base: ["15px", { lineHeight: "1.65", letterSpacing: "-0.006em" }],
        lg: ["18px", { lineHeight: "1.4", letterSpacing: "-0.011em" }],
        "2xl": ["24px", { lineHeight: "1.25", letterSpacing: "-0.018em" }],
      },
      // 间距阶: 只保留 4px 网格整档 (半档 class 不再生成 → 存量必须先行替换)
      spacing: {
        0: "0px",
        1: "4px",
        2: "8px",
        3: "12px",
        4: "16px",
        5: "20px",
        6: "24px",
        8: "32px",
        10: "40px",
        12: "48px",
        16: "64px",
      },
      // 圆角阶: 3 档收敛 (裸 rounded / lg / xl / 2xl 不再生成)
      borderRadius: {
        sm: "4px",
        md: "8px",
        full: "9999px",
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
