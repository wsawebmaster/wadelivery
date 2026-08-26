import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'var(--bg)',
          2: 'var(--bg-2)',
          3: 'var(--bg-3)',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          hover: 'var(--surface-hover)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        brand: {
          DEFAULT: 'var(--brand)',
          light: 'var(--brand-light)',
          dark: 'var(--brand-dark)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          strong: 'var(--accent-strong)',
          soft: 'var(--accent-soft)',
        },
        success: 'var(--success)',
        error: 'var(--error)',
        text: {
          DEFAULT: 'var(--text)',
          muted: 'var(--text-muted)',
          faint: 'var(--text-faint)',
        },
      },
      fontFamily: {
        body: ['var(--font-body)', 'system-ui', '-apple-system', 'sans-serif'],
        head: ['var(--font-head)', 'var(--font-body)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
      maxWidth: {
        container: 'var(--container)',
        narrow: '820px',
      },
      screens: {
        sm: '640px',
        md: '860px',
        lg: '1024px',
      },
      keyframes: {
        'drift-a': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(80px, 60px) scale(1.12)' },
        },
        'drift-b': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(-60px, 80px) scale(1.1)' },
        },
        'drift-c': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(70px, -50px) scale(1.08)' },
        },
        pulse: {
          '0%': { transform: 'scale(0.6)', opacity: '1' },
          '100%': { transform: 'scale(1.6)', opacity: '0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-16px)' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.25' },
        },
        'scroll-hint': {
          '0%': { transform: 'translateY(0)', opacity: '1' },
          '100%': { transform: 'translateY(14px)', opacity: '0' },
        },
        'bubble-in': {
          '0%': { opacity: '0', transform: 'translateY(10px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        bounce: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'modal-in': {
          '0%': { opacity: '0', transform: 'translateY(24px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'drift-a': 'drift-a 22s ease-in-out infinite',
        'drift-b': 'drift-b 26s ease-in-out infinite',
        'drift-c': 'drift-c 30s ease-in-out infinite',
        pulse: 'pulse 2s ease-out infinite',
        float: 'float 7s ease-in-out infinite',
        blink: 'blink 1.6s ease-in-out infinite',
        'scroll-hint': 'scroll-hint 1.8s ease-in-out infinite',
        'bubble-in': 'bubble-in 0.5s cubic-bezier(0.2, 0.7, 0.3, 1) forwards',
        bounce: 'bounce 2.6s ease-in-out infinite',
        'fade-in': 'fade-in 0.25s ease',
        'modal-in': 'modal-in 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.2)',
      },
    },
  },
  plugins: [],
}

export default config
