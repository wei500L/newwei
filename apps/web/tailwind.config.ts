import type { Config } from 'tailwindcss'
import { fontFamily } from 'tailwindcss/defaultTheme'

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      animation: {
        'aura-breathe': 'aura-breathe 15s ease-in-out infinite alternate',
      },
      keyframes: {
        'aura-breathe': {
          '0%': { transform: 'scale(1) translate(0, 0)', opacity: '0.8' },
          '50%': { transform: 'scale(1.05) translate(2%, -2%)', opacity: '1' },
          '100%': { transform: 'scale(0.95) translate(-2%, 2%)', opacity: '0.8' },
        }
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
    },
  },
  plugins: [],
}
export default config
