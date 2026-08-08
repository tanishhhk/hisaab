import React, { useRef } from 'react';
import { motion, useScroll, useTransform, useReducedMotion } from 'framer-motion';
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
  { from: 'Divya', text: 'I paid 1450 at 56 Dukan btw' },
  { from: 'Chetan', text: 'and the Mandu cab was 3500, I paid that' },
  { from: 'Asha', text: 'wait was Divya in the cab?' },
  { from: 'Divya', text: 'no I stayed back' },
  { from: 'You', text: 'so do I owe Rohan or Chetan', mine: true },
  { from: 'Asha', text: 'I paid 2400 at Sarafa, that was everyone' },
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

export default function Landing({ onStart, onSample, theme, onToggleTheme }: {
  onStart: () => void;
  onSample: () => void;
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
  const chatY = useTransform(scrollYProgress, [0, 1], ['0%', '-38%']);
  const chatOpacity = useTransform(scrollYProgress, [0, 0.45, 0.7], [1, 0.55, 0]);
  const chatBlur = useTransform(scrollYProgress, [0.2, 0.7], ['blur(0px)', 'blur(10px)']);
  const answerOpacity = useTransform(scrollYProgress, [0.5, 0.78], [0, 1]);
  const answerY = useTransform(scrollYProgress, [0.5, 0.78], [28, 0]);
  const answerScale = useTransform(scrollYProgress, [0.5, 0.78], [0.97, 1]);

  const still = reduce ? {} : undefined;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Wordmark />
        <div className="flex items-center gap-2">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
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
      <section className="mx-auto max-w-6xl px-6 pb-20 pt-10 sm:pt-16">
        <motion.h1
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-[14ch] font-display text-[clamp(2.75rem,9vw,6rem)] font-semibold leading-[0.95] tracking-tighter"
        >
          The trip is over.
          The hisaab is not.
        </motion.h1>

        <motion.p
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
          className="mt-7 max-w-[52ch] text-lg leading-relaxed text-ink-muted"
        >
          Six people, eleven bills, and nobody remembers who paid for the cab. Hisaab keeps the reckoning and works out the fewest
          payments that settle everyone up, down to the last paisa.
        </motion.p>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="mt-9 flex flex-wrap items-center gap-3"
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

        <p className="mt-5 text-sm text-ink-subtle">
          No account. Nothing leaves your browser.
        </p>
      </section>

      {/* The turn. One long scroll in which the mess is replaced by the answer. */}
      <section ref={turnRef} className="relative h-[260vh]">
        <div className="sticky top-0 flex h-screen items-center overflow-hidden">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 className="max-w-[16ch] font-display text-[clamp(1.9rem,4.4vw,3.25rem)] font-semibold leading-[1.02] tracking-tighter">
                This is the part everyone dreads.
              </h2>
              <p className="mt-5 max-w-[46ch] text-ink-muted">
                The arithmetic was never the hard bit. It is the reconstruction,
                three days later, from memory, in a chat where half the payments
                were never mentioned.
              </p>
              <motion.p
                style={still ?? { opacity: answerOpacity }}
                className="mt-8 max-w-[46ch] text-lg font-medium"
              >
                Hisaab reduces it to three payments.
              </motion.p>
            </div>

            <div className="relative h-[62vh] min-h-[420px]">
              <motion.div
                style={still ?? { y: chatY, opacity: chatOpacity, filter: chatBlur }}
                className="absolute inset-0 space-y-2 overflow-hidden pr-1"
                aria-hidden
              >
                {CHAT.map((c, i) => (
                  <ChatBubble key={i} {...c} />
                ))}
              </motion.div>

              <motion.div
                style={still ?? { opacity: answerOpacity, y: answerY, scale: answerScale }}
                className="absolute inset-x-0 top-1/2 -translate-y-1/2"
              >
                <div className="rounded-2xl border border-rule bg-surface p-6">
                  <div className="divide-y divide-rule">
                    {SETTLEMENT.map((s) => (
                      <div key={s.from} className="flex items-center justify-between gap-4 py-4">
                        <span className="flex min-w-0 items-center gap-2.5 font-medium">
                          <span className="truncate">{s.from}</span>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0 text-ink-subtle">
                            <path d="M3 12h16M14 6l6 6-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="truncate">{s.to}</span>
                        </span>
                        <span className="shrink-0 font-display text-xl font-semibold tnum tracking-tight">
                          ₹{s.amount}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 text-sm text-ink-subtle">
                    Four people, five expenses, ₹16,950, settled in three transfers.
                  </p>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </section>

      {/* What it actually does. Plain, because the argument is already made. */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <h2 className="max-w-[18ch] font-display text-[clamp(1.75rem,4vw,2.75rem)] font-semibold leading-[1.05] tracking-tighter">
          Built to be exactly right about money.
        </h2>
        <div className="mt-12 grid gap-x-10 gap-y-10 border-t border-rule pt-10 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['Splits that actually add up', 'Shares are worked out in paise and the remainder is handed out one at a time, so ₹100 across three people is 33.34 + 33.33 + 33.33, never ₹99.99.'],
            ['Equal or exact', 'Split evenly across whoever was there, or type each person’s amount by hand. Hisaab checks the parts against the total before it accepts them.'],
            ['The fewest transfers', 'Rather than everyone paying everyone, it collapses the whole trip into the shortest list of payments that clears the group.'],
            ['Leaves with your data', 'Export the whole trip to CSV or Excel, with a sheet per person and a summary that reconciles.'],
            ['Works with no signal', 'It runs entirely in your browser. On a bus, in a hill station, on aeroplane mode.'],
            ['People change mid-trip', 'Someone leaves early? Redistribute their share across who remains, or keep the history exactly as it was recorded.'],
          ].map(([title, body]) => (
            <motion.div
              key={title}
              initial={reduce ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            >
              <h3 className="font-display text-lg font-semibold tracking-tight">{title}</h3>
              <p className="mt-2 max-w-[42ch] text-[0.95rem] leading-relaxed text-ink-muted">{body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="border-t border-rule">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <h2 className="mx-auto max-w-[16ch] font-display text-[clamp(2rem,5vw,3.5rem)] font-semibold leading-[1.02] tracking-tighter">
            Settle the trip before you unpack.
          </h2>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <button
              onClick={onStart}
              className="rounded-full bg-ink px-7 py-3.5 font-medium text-canvas transition-colors hover:bg-ink/88"
            >
              Start a trip
            </button>
            <button
              onClick={onSample}
              className="rounded-full border border-rule-strong px-7 py-3.5 font-medium transition-colors hover:bg-sunken"
            >
              Open a worked example
            </button>
          </div>
        </div>
      </section>

      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-sm text-ink-subtle">
          <Wordmark />
          <span>Settle up, to the last paisa.</span>
        </div>
      </footer>
    </div>
  );
}
