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
      animation: {
        'aura-breathe': 'aura-breathe 22s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite',
        'aura-drift': 'aura-drift 30s cubic-bezier(0.42, 0, 0.58, 1) infinite',
        'aura-shimmer': 'aura-shimmer 18s cubic-bezier(0.4, 0, 0.2, 1) infinite',
      },
      keyframes: {
        'aura-breathe': {
          '0%': { transform: 'translate3d(0, 0, 0) scale(0.97)', opacity: '0.6' },
          '22%': { transform: 'translate3d(1.2%, -1%, 0) scale(1.01)', opacity: '0.72' },
          '50%': { transform: 'translate3d(2.4%, -2.2%, 0) scale(1.05)', opacity: '0.84' },
          '78%': { transform: 'translate3d(-1%, 1.5%, 0) scale(1)', opacity: '0.7' },
          '100%': { transform: 'translate3d(-2.1%, 2.2%, 0) scale(0.96)', opacity: '0.6' },
        },
        'aura-drift': {
          '0%': { transform: 'translate3d(0, 0, 0) scale(0.99) rotate(0deg)', opacity: '0.54' },
          '30%': { transform: 'translate3d(-2.4%, 1.8%, 0) scale(1.03) rotate(1.6deg)', opacity: '0.66' },
          '60%': { transform: 'translate3d(2%, -1.7%, 0) scale(0.98) rotate(-1.2deg)', opacity: '0.58' },
          '100%': { transform: 'translate3d(0.8%, 1%, 0) scale(1.01) rotate(0.8deg)', opacity: '0.54' },
        },
        'aura-shimmer': {
          '0%': { transform: 'translate3d(0, 0, 0) scale(0.98)', opacity: '0.24' },
          '40%': { transform: 'translate3d(0.8%, -1.1%, 0) scale(1.04)', opacity: '0.38' },
          '70%': { transform: 'translate3d(-0.6%, 0.6%, 0) scale(1.01)', opacity: '0.32' },
          '100%': { transform: 'translate3d(0, 0, 0) scale(0.98)', opacity: '0.24' },
        },
      },
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
      },
      borderRadius: {
        lg: 'var(--radius-lg)',
        DEFAULT: 'var(--radius)',
        md: 'var(--radius)',
        sm: 'calc(var(--radius) - 2px)',
      },
      fontSize: {
        reading: ['1rem', { lineHeight: '1.75' }],
        'reading-lg': ['1.0625rem', { lineHeight: '1.7' }],
      },
      maxWidth: {
        measure: 'var(--reading-measure)',
      },
      height: { ...vizHeights },
      minHeight: { ...vizHeights },
      maxHeight: { ...vizHeights },
    },
  },
  plugins: [],
}
export default config
