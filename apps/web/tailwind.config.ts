import type { Config } from 'tailwindcss';

/**
 * Semantic colour tokens (light + dark) and the two status palettes. Components
 * reference `bg-card` / `text-positive` etc.; the actual values are CSS custom
 * properties declared in src/style.css so a `dark` class on <html> repaints
 * everything at once.
 */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--bg) / <alpha-value>)',
        foreground: 'hsl(var(--fg) / <alpha-value>)',
        card: 'hsl(var(--card) / <alpha-value>)',
        'card-foreground': 'hsl(var(--fg) / <alpha-value>)',
        muted: 'hsl(var(--muted) / <alpha-value>)',
        'muted-foreground': 'hsl(var(--muted-fg) / <alpha-value>)',
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-fg) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--danger) / <alpha-value>)',
          foreground: 'hsl(0 0% 100% / <alpha-value>)',
        },
        positive: 'hsl(var(--positive) / <alpha-value>)',
        warning: 'hsl(var(--warning) / <alpha-value>)',
        info: 'hsl(var(--info) / <alpha-value>)',
        good: 'hsl(var(--good) / <alpha-value>)',
        accent: 'hsl(var(--accent) / <alpha-value>)',
        ink: 'hsl(var(--fg) / <alpha-value>)',
        'ink-faint': 'hsl(var(--muted-fg) / <alpha-value>)',
      },
      borderRadius: { md: '0.375rem', lg: '0.5rem' },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Apple SD Gothic Neo', 'Malgun Gothic', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
