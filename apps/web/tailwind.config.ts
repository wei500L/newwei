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
