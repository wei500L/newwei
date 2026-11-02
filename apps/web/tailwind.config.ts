import type { Config } from 'tailwindcss'
import { fontFamily } from 'tailwindcss/defaultTheme'

/**
 * P1 foundation: semantic visualization-container heights.
 * These replace scattered `h-[NNNpx]` magic numbers with named tokens.
 * Values map 1:1 to the most common existing heights (zero visual change);
 * deliberate consolidation of near-duplicates is a separate follow-up.
 */
const vizHeights = {
  'viz-xs': '180px',
  'viz-sm': '260px',
  'viz-md': '300px',
  'viz-lg': '360px',
  'viz-xl': '400px',
  'viz-2xl': '420px',
  'viz-3xl': '500px',
  'viz-4xl': '520px',
}

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      backdropBlur: {
        '20': '20px',
        '28': '28px',
        '32': '32px',
      },
      fontFamily: {
        sans: ['var(--font-sans)', ...fontFamily.sans],
        serif: ['var(--font-serif)', ...fontFamily.serif],
        mono: ['var(--font-mono)', ...fontFamily.mono],
      },
      colors: {
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        bullish: {
          DEFAULT: 'var(--bullish)',
          foreground: 'var(--bullish-foreground)',
        },
        bearish: {
          DEFAULT: 'var(--bearish)',
          foreground: 'var(--bearish-foreground)',
        },
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        surface: {
          DEFAULT: 'var(--surface)',
          muted: 'var(--surface-muted)',
        },
        'muted-foreground': 'var(--muted-foreground)',
        'border-strong': 'var(--border-strong)',
        // FE-UI 批8A：slate/gray 重映射为暖纸—墨色阶（README §3.2）。
        // 浅端 = 纸色 token，深端 = 墨色 token；存量 800+ 处冷灰类一次性变暖。
        // 必须写 hex（Tailwind 3 的 /opacity 修饰符无法作用于 var()）。
        slate: {
          50: '#faf8f3',
          100: '#f0ede6', // --surface-muted
          200: '#e3dfd6', // --border
          300: '#cfc9bc',
          400: '#9b978e',
          500: '#6b707a',
          600: '#5a6270', // --muted-foreground
          700: '#3a414d',
          800: '#232a35',
          900: '#161b26', // --foreground / 暗色卡片
          950: '#0d1117', // 暗色 --background
        },
        gray: {
          50: '#faf8f3',
          100: '#f0ede6',
          200: '#e3dfd6',
          300: '#cfc9bc',
          400: '#9b978e',
          500: '#6b707a',
          600: '#5a6270',
          700: '#3a414d',
          800: '#232a35',
          900: '#161b26',
          950: '#0d1117',
        },
        // FE-UI 批13B：剩余冷色相收敛到纸墨色板（README §3.2）。
        // 同一色相族保持彼此可区分（战争地图图例依赖 sky / indigo / cyan / emerald / rose / violet 的区分度）。
        sky: {      // 钢蓝：比墨蓝浅、偏青，与 indigo 区分
          50: '#f1f6f9', 100: '#dfeaf2', 200: '#bfd4e5', 300: '#93b6d2', 400: '#6593ba',
          500: '#42769f', 600: '#2f6189', 700: '#274f70', 800: '#22425c', 900: '#1d374c', 950: '#11222f',
        },
        blue: {     // 墨蓝（= --primary #1f3b7b 为 700）
          50: '#f2f5fa', 100: '#e3e9f4', 200: '#c5d1e8', 300: '#9fb3d9', 400: '#6f8cc4',
          500: '#4a6aa8', 600: '#2f5597', 700: '#1f3b7b', 800: '#1a3164', 900: '#15284f', 950: '#0e1a33',
        },
        indigo: {   // 与 blue 同族
          50: '#f2f5fa', 100: '#e3e9f4', 200: '#c5d1e8', 300: '#9fb3d9', 400: '#6f8cc4',
          500: '#4a6aa8', 600: '#2f5597', 700: '#1f3b7b', 800: '#1a3164', 900: '#15284f', 950: '#0e1a33',
        },
        emerald: {  // 松绿（600 = #2f7d5b，与 antd seed green 一致）
          50: '#f1f7f3', 100: '#ddeee3', 200: '#bcdcc8', 300: '#8fc3a3', 400: '#5ea67c',
          500: '#3d8a60', 600: '#2f7d5b', 700: '#256649', 800: '#1f523c', 900: '#1a4332', 950: '#0d251b',
        },
        green: {    // 与 emerald 同族
          50: '#f1f7f3', 100: '#ddeee3', 200: '#bcdcc8', 300: '#8fc3a3', 400: '#5ea67c',
          500: '#3d8a60', 600: '#2f7d5b', 700: '#256649', 800: '#1f523c', 900: '#1a4332', 950: '#0d251b',
        },
        rose: {     // 朱红（600 = --destructive #b91c1c）
          50: '#fbf3f1', 100: '#f6e2dd', 200: '#ecc3ba', 300: '#df988a', 400: '#cf6a57',
          500: '#c24433', 600: '#b91c1c', 700: '#9a1b17', 800: '#7f1d17', 900: '#6a1c17', 950: '#3b0c09',
        },
        red: {      // 与 rose 同族
          50: '#fbf3f1', 100: '#f6e2dd', 200: '#ecc3ba', 300: '#df988a', 400: '#cf6a57',
          500: '#c24433', 600: '#b91c1c', 700: '#9a1b17', 800: '#7f1d17', 900: '#6a1c17', 950: '#3b0c09',
        },
        cyan: {     // 青绿（600 = #0f766e，与 antd seed cyan 一致）
          50: '#f0f7f6', 100: '#d9ecea', 200: '#b3d8d4', 300: '#82beb8', 400: '#4f9f97',
          500: '#2f857c', 600: '#0f766e', 700: '#0f5f59', 800: '#114c48', 900: '#123f3c', 950: '#062321',
        },
        violet: {   // 靛紫（600 = #5b4b8a，与 antd seed purple 一致）
          50: '#f5f3f9', 100: '#e9e5f2', 200: '#d3cbe5', 300: '#b4a8d2', 400: '#8f7fb8',
          500: '#73639f', 600: '#5b4b8a', 700: '#4b3e72', 800: '#3e345d', 900: '#342c4d', 950: '#1f1a2f',
        },
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: 'var(--radius)',      // 6px
        md: 'var(--radius)',           // 6px
        lg: 'var(--radius-lg)',        // 10px
        xl: '12px',
        '2xl': '16px',
      },
      fontSize: {
        reading: ['1rem', { lineHeight: '1.75' }],
        'reading-lg': ['1.0625rem', { lineHeight: '1.7' }],
      },
      maxWidth: {
        measure: 'var(--reading-measure)',
      },
      boxShadow: {
        // 面板/卡片标准阴影，随主题切换
        panel: 'var(--shadow-surface)',
      },
      height: { ...vizHeights },
      minHeight: { ...vizHeights },
      maxHeight: { ...vizHeights },
    },
  },
  plugins: [],
}
export default config
