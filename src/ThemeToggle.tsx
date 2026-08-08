import React, { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'hisaab_theme';

// Light is the default. The operating system preference is deliberately not
// consulted, because a money app that opens dark on a bright morning reads as
// broken more often than it reads as clever.
function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    // Keep the browser chrome in step with the page.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#131211' : '#fbf9f6');
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* storage can be unavailable in private mode; the theme still applies */
    }
  }, [theme]);

  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}

export default function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-rule-strong text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
    >
      {dark ? (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-[18px] w-[18px]">
          <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="M12 3.2v1.6M12 19.2v1.6M3.2 12h1.6M19.2 12h1.6M5.8 5.8l1.1 1.1M17.1 17.1l1.1 1.1M18.2 5.8l-1.1 1.1M6.9 17.1l-1.1 1.1"
            stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-[18px] w-[18px]">
          <path
            d="M20 13.4A8.2 8.2 0 0 1 10.6 4a8.4 8.4 0 1 0 9.4 9.4Z"
            stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
