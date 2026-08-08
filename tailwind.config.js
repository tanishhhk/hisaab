/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        canvas: token('canvas'),
        surface: token('surface'),
        sunken: token('sunken'),
        rule: { DEFAULT: token('rule'), strong: token('rule-strong') },
        ink: {
          DEFAULT: token('ink'),
          muted: token('ink-muted'),
          subtle: token('ink-subtle'),
        },
        accent: { DEFAULT: token('accent'), soft: token('accent-soft') },
        // Money direction. Never used on a control, so a green button can
        // never be mistaken for a balance.
        credit: { DEFAULT: token('credit'), soft: token('credit-soft') },
        debit: { DEFAULT: token('debit'), soft: token('debit-soft') },
      },
      fontFamily: {
        sans: ["'Schibsted Grotesk Variable'", 'system-ui', 'sans-serif'],
        display: ["'Bricolage Grotesque Variable'", 'Georgia', 'serif'],
      },
      letterSpacing: {
        tight: '-0.02em',
        tighter: '-0.03em',
      },
      // Elevation is declared once, as a hairline. The only shadow in the
      // system lifts a modal off the page, where floating is the point.
      boxShadow: {
        modal: '0 24px 60px -20px rgb(0 0 0 / 0.35), 0 8px 20px -12px rgb(0 0 0 / 0.25)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        rise: {
          from: { opacity: '0', transform: 'translateY(10px) scale(0.99)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out both',
        rise: 'rise 260ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
}
