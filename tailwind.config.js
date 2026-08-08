/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        // Action colour. Deliberately not green: this app already spends
        // green/red on "is owed" vs "owes", so a green button would read as
        // a balance rather than a control.
        brand: {
          50: '#EEF2FF',
          100: '#E0E7FF',
          200: '#C7D2FE',
          600: '#4F46E5',
          700: '#4338CA',
        },
        // Money semantics. credit = they are owed, debit = they owe.
        credit: { 50: '#ECFDF5', 100: '#D1FAE5', 600: '#059669', 700: '#047857' },
        debit: { 50: '#FFF1F2', 100: '#FFE4E6', 600: '#E11D48', 700: '#BE123C' },
      },
      boxShadow: {
        // Softer than flat, clearer than neumorphism.
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 4px 16px -6px rgb(15 23 42 / 0.10)',
        lift: '0 2px 4px 0 rgb(15 23 42 / 0.05), 0 12px 28px -10px rgb(15 23 42 / 0.18)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        rise: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out both',
        rise: 'rise 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
}
