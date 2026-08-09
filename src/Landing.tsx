import React, { useRef } from 'react';
import { motion, useScroll, useSpring, useTransform, useReducedMotion } from 'framer-motion';
import ThemeToggle from './ThemeToggle';

// The argument this page makes, in order:
//   1. You already know the problem. Here it is, in your own words.
//   2. It is worse than you remember. (The flood.)
//   3. It collapses to three lines. (The turn, the one authored moment.)
//   4. Here is the working thing. Touch it.
// Everything else is quiet.

const CHAT: { from: string; text: string; mine?: boolean }[] = [
  { from: 'Rohan', text: 'guys settle up karo, I paid for the hotel' },
  { from: 'Asha', text: 'how much was it' },
  { from: 'Rohan', text: '8600 for both nights' },
  { from: 'Divya', text: 'I paid 1450 for breakfast btw' },
  { from: 'Chetan', text: 'and the cab to the fort was 3500, I paid that' },
  { from: 'Asha', text: 'wait was Divya in the cab?' },
  { from: 'Divya', text: 'no I stayed back' },
  { from: 'You', text: 'so do I owe Rohan or Chetan', mine: true },
  { from: 'Asha', text: 'I paid 2400 at the night market, that was everyone' },
  { from: 'Chetan', text: 'didn’t you already pay me back for petrol' },
  { from: 'Rohan', text: 'that was last trip' },
  { from: 'Asha', text: 'guys can someone just make a sheet' },
  { from: 'Divya', text: 'not it' },
  { from: 'You', text: 'ok I’ll do it', mine: true },
];

const SETTLEMENT = [
  { from: 'Asha', to: 'Rohan', amount: '1,479.17' },
  { from: 'Chetan', to: 'Rohan', amount: '779.16' },
  { from: 'Divya', to: 'Rohan', amount: '2,062.50' },
];

function Wordmark() {
  return (
    <span className="font-display text-[1.35rem] font-semibold tracking-tighter">
      Hisaab
    </span>
  );
}

// The one word in the headline that is the product's name, marked in the accent
// colour. The motion is deliberately small: a ledger rule drawn under the word,
// and a few rupee marks settling upward out of it. Money, stated quietly.
function HisaabWord() {
  const reduce = useReducedMotion();
  return (
    <span className="relative inline-block text-accent">
      hisaab
      <svg
        viewBox="0 0 100 4"
        preserveAspectRatio="none"
        aria-hidden
        className="absolute inset-x-0 -bottom-[0.06em] h-[0.1em] w-full overflow-visible"
      >
        <motion.path
          d="M0 2 H100"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          initial={reduce ? false : { pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.9, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>

      {!reduce &&
        [0, 1, 2].map((i) => (
          <motion.span
            key={i}
            aria-hidden
            className="pointer-events-none absolute z-10 font-sans text-[0.28em] font-semibold text-accent"
            style={{ left: `${24 + i * 26}%`, top: '-0.15em' }}
            initial={{ opacity: 0, y: '0.9em' }}
            animate={{ opacity: [0, 1, 1, 0], y: ['0.9em', '-0.5em'] }}
            transition={{
              duration: 2.4,
              times: [0, 0.25, 0.6, 1],
              delay: 1.3 + i * 0.45,
              repeat: Infinity,
              repeatDelay: 1.8,
              ease: 'easeOut',
            }}
          >
            ₹
          </motion.span>
        ))}
    </span>
  );
}


// The hero's other half: the hisaab actually being kept. Entries land one at a
// time onto ruled lines and the total climbs with them, ending at the same
// 16,950 the settlement later resolves. The recording and the reckoning are
// the same trip, seen twice.
const LEDGER: { what: string; who: string; amount: number; note?: string }[] = [
  { what: 'Hotel, two nights', who: 'Rohan', amount: 8600 },
  // Two people put money in at the counter, which Hisaab records as two
  // payments against one expense and still settles correctly.
  { what: 'Night market food', who: 'Asha and Rohan', amount: 2400, note: 'split payment' },
  { what: 'Cab to the fort', who: 'Chetan', amount: 3500 },
  { what: 'Petrol', who: 'Asha', amount: 1000 },
  { what: 'Breakfast, day two', who: 'Divya', amount: 1450 },
];

const inr = (n: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// One restaurant bill, itemised, because the argument this section settles is
// about specific dishes. Tax is 5% of each group's own food, which is the whole
// point: it follows what was ordered, not how many people sat down.
// 380+280+240 = 900, 640+420+140 = 1200, so 2,100 food and 105.00 tax.
const BILL: {
  who: string;
  ate: string;
  items: [string, string][];
  food: string;
  tax: string;
  sum: string;
  by: number;
  each: string;
}[] = [
  {
    who: 'Asha and Divya',
    ate: 'ate vegetarian',
    items: [
      ['Paneer tikka', '380.00'],
      ['Dal makhani', '280.00'],
      ['Jeera rice', '240.00'],
    ],
    food: '900.00',
    tax: '45.00',
    sum: '945.00',
    by: 2,
    each: '472.50',
  },
  {
    who: 'Rohan, Bilal and Chetan',
    ate: 'had the biryani and the fish',
    items: [
      ['Hyderabadi biryani', '640.00'],
      ['Fish curry', '420.00'],
      ['Butter naan', '140.00'],
    ],
    food: '1,200.00',
    tax: '60.00',
    sum: '1,260.00',
    by: 3,
    each: '420.00',
  },
];

// The leader dots that run from a dish to its price. A real bill's device, and
// the thing that makes a two-column list read as one line rather than two.
function Leader() {
  return (
    <span
      aria-hidden
      className="mx-2 min-w-[1.5rem] flex-1 translate-y-[-0.28em] border-b border-dotted border-ink/25"
    />
  );
}

function LedgerStrip({ reduce }: { reduce: boolean }) {
  const [shown, setShown] = React.useState(reduce ? LEDGER.length : 0);

  React.useEffect(() => {
    if (reduce) return;
    if (shown >= LEDGER.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 900 : 620);
    return () => clearTimeout(t);
  }, [shown, reduce]);

  const running = LEDGER.slice(0, shown).reduce((a, b) => a + b.amount, 0);

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="relative rounded-2xl border border-rule bg-surface/80 p-6 backdrop-blur-[2px]"
      aria-hidden
    >
      <span className="pointer-events-none absolute -right-2 -top-3 rotate-[9deg] rounded-md border border-accent/50 bg-canvas px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-accent">
        sample
      </span>
      <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-3">
        <span className="font-display text-lg tracking-tight">Hill trip, three nights</span>
        <span className="text-sm text-ink-subtle">4 people</span>
      </div>

      <ul className="mt-1">
        {LEDGER.map((row, i) => (
          <li
            key={row.what}
            className={`flex items-baseline justify-between gap-4 border-b border-rule py-2.5 transition-all duration-500 ${
              i < shown ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
            }`}
          >
            <span className="min-w-0">
              <span className="block truncate text-[0.95rem]">{row.what}</span>
              <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
                {row.who} paid
                {row.note && (
                  <span className="rounded-full bg-accent-soft px-1.5 py-0.5 font-medium text-accent">
                    {row.note}
                  </span>
                )}
              </span>
            </span>
            <span className="shrink-0 tnum text-[0.95rem]">&#8377;{inr(row.amount)}</span>
          </li>
        ))}
      </ul>

      <div className="flex items-baseline justify-between gap-4 pt-4">
        <span className="text-sm text-ink-muted">Running total</span>
        <span className="font-display text-3xl tracking-tight tnum">&#8377;{inr(running)}</span>
      </div>
    </motion.div>
  );
}


// Replace the href values with your own. Kept in one place so there is exactly
// one line to edit per account.

const SOCIAL_ICONS: Record<string, React.ReactNode> = {
  GitHub: (
    <path
      fill="currentColor"
      d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85 0 1.34-.01 2.42-.01 2.75 0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10Z"
    />
  ),
  Instagram: (
    <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="5.2" />
      <circle cx="12" cy="12" r="3.9" />
      <circle cx="17.2" cy="6.8" r="1.05" fill="currentColor" stroke="none" />
    </g>
  ),
  LinkedIn: (
    <path
      fill="currentColor"
      d="M4.98 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM3 9h4v12H3V9Zm6 0h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.4c0-1.29-.02-2.95-1.8-2.95-1.8 0-2.08 1.4-2.08 2.85V21H9V9Z"
    />
  ),
};

const SOCIALS: { label: string; href: string; caption: string }[] = [
  { label: 'GitHub', href: 'https://github.com/tanishhhk', caption: 'every bug, publicly, forever' },
  { label: 'Instagram', href: 'https://www.instagram.com/_tanishhhkk', caption: 'mostly food I did not split fairly' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/tanishhhk', caption: 'the one wearing a collar' },
];

// A caption that rises on hover and on keyboard focus, so it is reachable
// without a mouse.
function SocialLink({ label, href, caption }: { label: string; href: string; caption: string }) {
  return (
    <span className="group relative inline-block">
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-[15rem] -translate-x-1/2 translate-y-1 rounded-full border border-rule bg-ink px-3 py-1.5 text-xs font-medium text-canvas opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
      >
        {caption}
      </span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-2 rounded-full border border-rule-strong px-4 py-2 text-sm font-medium transition-colors hover:bg-sunken"
      >
        <svg viewBox="0 0 24 24" aria-hidden className="h-[17px] w-[17px]">
          {SOCIAL_ICONS[label]}
        </svg>
        {label}
      </a>
    </span>
  );
}

const FEEDBACK_TO = 'tanishkjain3011@gmail.com';

// No backend needed: the note is handed to the visitor's own mail app with the
// subject and body already written. Nothing is stored, nothing is tracked, and
// it works the moment the page is deployed.
function Feedback() {
  const [note, setNote] = React.useState('');
  const [sent, setSent] = React.useState(false);

  const send = () => {
    const body = note.trim();
    if (!body) return;
    window.location.href =
      `mailto:${FEEDBACK_TO}` +
      `?subject=${encodeURIComponent('Hisaab feedback')}` +
      `&body=${encodeURIComponent(body)}`;
    setSent(true);
  };

  return (
    <div className="rounded-2xl border border-rule bg-surface p-6">
      <h3 className="font-display text-xl tracking-tight">Tell me what broke</h3>
      <p className="mt-1.5 text-sm text-ink-muted">
        Or what you wish it did. It goes straight to my inbox, and I read all of
        it.
      </p>

      {sent ? (
        <p className="mt-5 rounded-xl border border-credit/25 bg-credit-soft px-4 py-3 text-sm font-medium text-credit">
          Your mail app should be open. Thank you, genuinely.
        </p>
      ) : (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder="The split for the auto rickshaw came out wrong when..."
            className="mt-5 w-full resize-none rounded-2xl border border-rule bg-canvas p-3.5 text-sm transition focus:border-accent"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-subtle">Opens your mail app</span>
            <button
              onClick={send}
              disabled={!note.trim()}
              className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-ink/88 disabled:opacity-40"
            >
              Send it
            </button>
          </div>
        </>
      )}
    </div>
  );
}


// The band was telling people to install without offering to do it. Chrome and
// Edge fire beforeinstallprompt when the app qualifies; we hold that event and
// spend it on a real button. iOS Safari never fires it, so that case falls back
// to naming the actual gesture rather than pretending a button exists.
// Matches the lg: breakpoint the layout classes use, so the motion and the
// grid agree about which arrangement is on screen.
function useWide(): boolean {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return wide;
}

function InstallBand() {
  const [prompt, setPrompt] = React.useState<any>(null);
  const [installed, setInstalled] = React.useState(false);

  React.useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e); };
    const onInstalled = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    if (window.matchMedia('(display-mode: standalone)').matches) setInstalled(true);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const isIOS = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

  return (
    <section className="border-y border-rule bg-sunken">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-16 lg:grid-cols-[auto_1fr_auto]">
        {/* The mark that will actually sit on their home screen. */}
        <div className="flex items-center gap-4">
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-[1.15rem] bg-ink">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-8 w-8 text-canvas">
              <path d="M4 12h13M13 7l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="font-display text-2xl tracking-tighter lg:hidden">Hisaab</span>
        </div>

        <div>
          <p className="max-w-[34ch] font-display text-[clamp(1.5rem,2.6vw,2.1rem)] leading-[1.15] tracking-tight">
            Expressive millennial or nonchalant Gen Z, the hisaab comes for
            everyone.
          </p>
          <p className="mt-3 max-w-[52ch] text-ink-muted">
            Keep it on your home screen. It opens with no signal, so it still
            works on the bus back.
          </p>
        </div>

        <div className="shrink-0">
          {installed ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-credit/30 bg-credit-soft px-5 py-3 text-sm font-medium text-credit">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-4 w-4">
                <path d="M4 12.5 9 17.5 20 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Already on your home screen
            </span>
          ) : prompt ? (
            <button
              onClick={async () => { prompt.prompt(); await prompt.userChoice; setPrompt(null); }}
              className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3 font-medium text-canvas transition-colors hover:bg-ink/88"
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-[18px] w-[18px]">
                <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Add to home screen
            </button>
          ) : (
            <p className="max-w-[19ch] text-sm text-ink-subtle">
              {isIOS
                ? 'On iPhone: tap Share, then Add to Home Screen.'
                : 'Use your browser menu, then Install or Add to Home Screen.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ChatBubble({ from, text, mine }: { from: string; text: string; mine?: boolean }) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-[0.9rem] leading-snug ${
          mine
            ? 'rounded-br-md bg-accent-soft text-ink'
            : 'rounded-bl-md border border-rule bg-surface text-ink'
        }`}
      >
        {!mine && <div className="text-[0.7rem] font-medium text-ink-subtle">{from}</div>}
        {text}
      </div>
    </div>
  );
}

export default function Landing({ onStart, onSample, onSignIn, signedIn, theme, onToggleTheme }: {
  onStart: () => void;
  onSample: () => void;
  onSignIn?: () => void;
  signedIn?: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const reduce = useReducedMotion();
  const turnRef = useRef<HTMLDivElement>(null);

  // The flood and the resolution are two states of one scroll. The chat scrolls
  // up and fades as the settlement rises through it, so the page performs the
  // substitution the product performs.
  const { scrollYProgress } = useScroll({
    target: turnRef,
    offset: ['start start', 'end start'],
  });
  // Raw scroll position is jittery, especially on a trackpad or a phone.
  // Running it through a spring smooths the whole sequence at once.
  const p = useSpring(scrollYProgress, { stiffness: 90, damping: 26, restDelta: 0.0005 });

  // The two states overlap: the chat is still leaving as the answer arrives,
  // so it reads as a substitution rather than two separate fades.
  const chatY = useTransform(p, [0, 1], ['0%', '-24%']);
  const chatOpacity = useTransform(p, [0, 0.3, 0.55], [1, 0.7, 0]);
  const chatBlur = useTransform(p, [0.1, 0.55], ['blur(0px)', 'blur(8px)']);
  const answerOpacity = useTransform(p, [0.3, 0.6], [0, 1]);
  const answerY = useTransform(p, [0.3, 0.6], [22, 0]);
  const answerScale = useTransform(p, [0.3, 0.6], [0.975, 1]);

  // The pinned substitution needs a tall viewport and two columns to read. On a
  // phone there is room for the text or the chat, never both, so the scroll
  // scrub is switched off and the section plays out as ordinary stacked
  // content. Without this the answer card stays at opacity 0, because its
  // opacity is driven by a scroll range that no longer exists.
  const wide = useWide();
  const still = reduce || !wide ? {} : undefined;

  return (
    <div className="ledger-ground min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Wordmark />
        <div className="flex items-center gap-2">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          {onSignIn && !signedIn && (
            <button
              onClick={onSignIn}
              className="rounded-full px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
            >
              Sign in
            </button>
          )}
          <button
            onClick={onStart}
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-ink/88"
          >
            Open Hisaab
          </button>
        </div>
      </header>

      {/* Hero. The question is the headline because it is the sentence every
          group actually sends. */}
      <section className="mx-auto grid max-w-6xl gap-12 px-6 pb-28 pt-8 sm:pt-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:pb-40">
        <div>
        <motion.h1
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="font-display text-[clamp(2.35rem,5.6vw,4.5rem)] font-semibold leading-[0.98] tracking-tighter [text-wrap:balance]"
        >
          The trip is over.
          <br />
          The <HisaabWord /> is not.
        </motion.h1>

        <motion.p
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
          className="mt-6 max-w-[52ch] text-lg leading-relaxed text-ink-muted"
        >
          Everyone paid for something. Nobody agrees on what. Hisaab works it
          out and clears the whole group in the fewest payments possible —
          exact to the last paisa.
        </motion.p>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="mt-8 flex flex-wrap items-center gap-3"
        >
          <button
            onClick={onStart}
            className="rounded-full bg-ink px-6 py-3 font-medium text-canvas transition-colors hover:bg-ink/88"
          >
            Start a trip
          </button>
          <button
            onClick={onSample}
            className="rounded-full border border-rule-strong px-6 py-3 font-medium transition-colors hover:bg-sunken"
          >
            Open a worked example
          </button>
        </motion.div>

        <p className="mt-4 text-sm text-ink-subtle">
          No account needed. Nothing leaves your browser.
          {onSignIn && !signedIn && (
            <>
              {' '}
              <button
                onClick={onSignIn}
                className="rounded-full font-medium text-ink underline decoration-accent decoration-2 underline-offset-4 transition-opacity hover:opacity-70"
              >
                Create an account
              </button>{' '}
              to keep trips across devices.
            </>
          )}
        </p>
        </div>

        <LedgerStrip reduce={!!reduce} />
      </section>

      {/* The turn. One long scroll in which the mess is replaced by the answer. */}
      <section ref={turnRef} className="relative lg:h-[200vh]">
        <div className="py-20 lg:sticky lg:top-0 lg:flex lg:h-screen lg:items-center lg:overflow-hidden lg:py-0">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 className="max-w-[15ch] font-display text-[clamp(1.9rem,4.4vw,3.25rem)] font-semibold leading-[1.02] tracking-tighter">
                Three days later, in the group chat.
              </h2>
              <p className="mt-5 max-w-[44ch] text-lg text-ink-muted">
                This is the part everyone dreads. The arithmetic was never the
                hard bit. It is the reconstruction, from memory, in a chat where
                half the payments were never mentioned.
              </p>
              <motion.p
                style={still ?? { opacity: answerOpacity }}
                className="mt-8 max-w-[46ch] text-lg font-medium"
              >
                Hisaab reduces it to three payments.
              </motion.p>
            </div>

            {/* Two states of one idea. On a wide screen they occupy the same
                cell and cross-fade under the scroll. Stacked, they simply
                follow one another, because a phone cannot hold both at once
                and centring a 12-message thread in a fixed-height cell made it
                bleed upward over the paragraph. */}
            <div className="relative flex flex-col gap-8 lg:grid lg:h-[58vh] lg:min-h-[400px] lg:place-items-center lg:gap-0">
              <motion.div
                style={still ?? { y: chatY, opacity: chatOpacity, filter: chatBlur }}
                className="chat-fade w-full space-y-2 overflow-hidden lg:col-start-1 lg:row-start-1 lg:self-center"
                aria-hidden
              >
                {CHAT.map((c, i) => (
                  <ChatBubble key={i} {...c} />
                ))}
              </motion.div>

              <motion.div
                style={still ?? { opacity: answerOpacity, y: answerY, scale: answerScale }}
                className="w-full lg:col-start-1 lg:row-start-1 lg:self-center"
              >
                <div className="rounded-2xl border border-rule bg-surface p-6">
                  <p className="text-sm text-ink-muted">Everyone settles with one payment.</p>
                  <div className="mt-3 divide-y divide-rule">
                    {SETTLEMENT.map((s2) => (
                      <div key={s2.from} className="flex items-center justify-between gap-4 py-3.5">
                        <span className="flex min-w-0 items-center gap-2.5 font-medium">
                          <span className="truncate">{s2.from}</span>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0 text-ink-subtle">
                            <path d="M3 12h16M14 6l6 6-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="truncate">{s2.to}</span>
                        </span>
                        <span className="shrink-0 font-display text-xl font-semibold tnum tracking-tight">
                          &#8377;{s2.amount}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 border-t border-rule pt-4 text-[0.95rem] leading-relaxed text-ink">
                    Four people, five expenses, <span className="font-semibold tnum">&#8377;16,950</span>,
                    settled in <span className="font-semibold">three transfers</span>.
                  </p>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </section>

      {/* The claim, then the proof. A real bill, split the awkward way, with
          the arithmetic shown rather than asserted. */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <h2 className="max-w-[18ch] font-display text-[clamp(1.75rem,4vw,2.75rem)] font-semibold leading-[1.05] tracking-tighter">
          Three ate the biryani. Two did not.
        </h2>
        <p className="mt-5 max-w-[52ch] text-lg text-ink-muted">
          Not everything divides by the number of people at the table. The two
          who ate vegetarian pay for what they ordered, the tax follows the food
          rather than the headcount, and each group splits its own total.
        </p>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-12 max-w-[34rem] overflow-hidden rounded-2xl border border-rule bg-surface"
        >
          {/* Set as the bill itself: centred header, leader dots, figures in a
              right-aligned tabular column, a double rule above the total. The
              annotations are the only thing a paper bill would not have. */}
          <div className="border-b border-dashed border-rule px-6 py-6 text-center sm:px-8">
            <h3 className="font-display text-lg tracking-[0.2em] uppercase">One dinner bill</h3>
            <p className="mt-1.5 text-xs uppercase tracking-[0.18em] text-ink-subtle">
              Table 7 · Five covers
            </p>
          </div>

          <div className="divide-y divide-dashed divide-rule">
            {BILL.map((g) => (
              <div key={g.who} className="px-6 py-6 sm:px-8">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{g.who}</span>
                  <span className="text-sm text-ink-subtle">{g.ate}</span>
                </div>

                <div className="mt-3.5 space-y-1.5 text-[0.95rem]">
                  {g.items.map(([dish, price]) => (
                    <div key={dish} className="flex items-baseline">
                      <span className="text-ink-muted">{dish}</span>
                      <Leader />
                      <span className="tnum shrink-0 text-ink">{price}</span>
                    </div>
                  ))}
                  <div className="flex items-baseline pt-1.5 text-ink-subtle">
                    <span>Tax at 5%</span>
                    <Leader />
                    <span className="tnum shrink-0">{g.tax}</span>
                  </div>
                  <div className="flex items-baseline border-t border-rule pt-2 font-medium">
                    <span>Their share of the bill</span>
                    <Leader />
                    <span className="tnum shrink-0">{g.sum}</span>
                  </div>
                </div>

                {/* The annotation a paper bill cannot make: the same figure,
                    divided. Tinted rather than boxed so it reads as a note in
                    the margin instead of a second card. */}
                <div className="mt-3.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl bg-accent/[0.07] px-3.5 py-2.5 text-[0.95rem] tnum">
                  <span className="text-ink-muted">&#8377;{g.sum} between {g.by}</span>
                  <span className="flex items-baseline gap-2 whitespace-nowrap">
                    <span className="text-ink-subtle">=</span>
                    <span className="font-display text-2xl tracking-tight text-ink">
                      &#8377;{g.each}
                    </span>
                    <span className="text-ink-subtle">each</span>
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-dashed border-rule bg-sunken px-6 py-6 sm:px-8">
            <div className="flex items-baseline text-ink-muted">
              <span>Food</span>
              <Leader />
              <span className="tnum shrink-0">2,100.00</span>
            </div>
            <div className="mt-1.5 flex items-baseline text-ink-muted">
              <span>Tax</span>
              <Leader />
              <span className="tnum shrink-0">105.00</span>
            </div>
            {/* The double rule above a total is the one typographic convention
                every printed bill shares. */}
            <div className="mt-3 flex items-baseline border-t-[3px] border-double border-ink/25 pt-3">
              <span className="font-display text-lg tracking-tight">Total</span>
              <Leader />
              <span className="tnum shrink-0 font-display text-2xl tracking-tight">
                &#8377;2,205.00
              </span>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-ink-muted">
              <span className="tnum">
                Two at &#8377;472.50 and three at &#8377;420.00 comes to &#8377;2,205.00.
              </span>{' '}
              Exactly the bill. Nobody subsidised the biryani.
            </p>
          </div>
        </motion.div>

        {/* A nod to the category, never a name. It earns its keep only
            because the six proofs directly below are concrete, so it reads
            as a summary of evidence rather than a boast. */}
        <p className="mt-16 max-w-[44ch] border-t border-rule pt-10 font-display text-[clamp(1.15rem,2.2vw,1.5rem)] leading-[1.25] tracking-tight">
          Plenty of apps put <span className="italic">wise</span> in the name.
          We would rather put it in the arithmetic.
        </p>

        {/* Stacked on a phone these ran together as one grey column, so each
            proof gets a rule and real breathing room. The dividers disappear
            once the grid has columns to do that work instead. */}
        <div className="mt-9 grid divide-y divide-rule sm:grid-cols-2 sm:gap-x-10 sm:gap-y-9 sm:divide-y-0 lg:grid-cols-3">
          {[
            ['Nothing goes missing in the rounding', 'Shares are worked out in paise and the odd remainder is handed out one at a time, so ₹100 across three people is 33.34 plus 33.33 plus 33.33, never ₹99.99.'],
            ['The fewest transfers', 'Rather than everyone paying everyone, the whole trip collapses into the shortest list of payments that clears the group.'],
            ['People change mid-trip', 'Someone leaves early? Redistribute their share across who remains, or keep the history exactly as it was recorded.'],
            ['Leaves with your data', 'Export the whole trip to CSV or Excel, with a row per person per expense and a summary that reconciles.'],
            ['Works with no signal', 'It runs entirely in your browser, and installs to your phone. On a bus, in a hill station, on aeroplane mode.'],
            ['It checks your maths', 'Type the amounts by hand and Hisaab tells you how far off the total you are, and in which direction, before it accepts them.'],
          ].map(([title, body]) => (
            <motion.div
              key={title}
              initial={reduce ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="py-7 first:pt-0 sm:py-0"
            >
              <h3 className="font-display text-xl font-semibold tracking-tight sm:text-lg">{title}</h3>
              <p className="mt-2 max-w-[42ch] text-[0.95rem] leading-relaxed text-ink-muted">{body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <InstallBand />

      <section className="border-t border-rule">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <h2 className="mx-auto max-w-[16ch] font-display text-[clamp(2rem,5vw,3.5rem)] font-semibold leading-[1.02] tracking-tighter">
            Settle the trip before you unpack.
          </h2>

        </div>
      </section>

      <footer className="border-t border-rule">
        <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <h2 className="max-w-[20ch] font-display text-[clamp(1.5rem,3vw,2.1rem)] leading-[1.1] tracking-tighter">
              Built by someone who was tired of being the one with the calculator.
            </h2>
            <p className="mt-4 max-w-[46ch] text-ink-muted">
              Hisaab exists because settling up should take a minute, not forty
              messages and a wrong answer. It is free, it has no adverts, and it
              will never ask who you had dinner with. If it saves you one
              argument, it has paid for itself.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-2">
              {SOCIALS.map((link) => (
                <SocialLink key={link.label} {...link} />
              ))}
            </div>
          </div>

          <Feedback />
        </div>

        <div className="border-t border-rule">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-sm text-ink-subtle">
            <Wordmark />
            <span>Settle up, to the last paisa.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
