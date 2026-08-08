import React, { useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

// Two steps, one screen. Ask for an email, send a six digit code, take the
// code. No password to choose, forget, or reset.
type Step = 'email' | 'code';

export function useSession(): { session: Session | null; user: User | null; ready: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!supabase);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, user: session?.user ?? null, ready };
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

export default function SignIn({ reason, onClose, onSignedIn }: {
  reason?: string;
  onClose: () => void;
  onSignedIn: () => void;
}) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const sendCode = async () => {
    const trimmed = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) return setError('That does not look like an email address.');
    if (!supabase) return setError('Sign in is not available right now.');
    setBusy(true);
    setError('');
    const { error: err } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (err) return setError(err.message);
    setStep('code');
  };

  const verify = async () => {
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) return setError('The code is six digits.');
    if (!supabase) return setError('Sign in is not available right now.');
    setBusy(true);
    setError('');
    const { error: err } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: digits,
      type: 'email',
    });
    setBusy(false);
    if (err) return setError('That code did not work. Check it, or send a new one.');
    onSignedIn();
  };

  const field =
    'w-full rounded-full border bg-surface px-4 py-2.5 text-sm transition focus:border-accent';

  return (
    <div className="space-y-4">
      <div>
        <h3 id="signin-title" className="font-display text-xl tracking-tight">
          {step === 'email' ? 'Sign in to Hisaab' : 'Check your email'}
        </h3>
        <p className="mt-1 text-sm text-ink-muted">
          {step === 'email'
            ? reason || 'We will email you a six digit code. No password to remember.'
            : `We sent a six digit code to ${email.trim()}. It expires in an hour.`}
        </p>
      </div>

      {step === 'email' ? (
        <>
          <input
            type="email"
            autoFocus
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') sendCode(); }}
            aria-invalid={!!error}
            className={`${field} ${error ? 'border-debit' : 'border-rule'}`}
          />
          {error && <p role="alert" className="text-sm text-debit">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-full border border-rule-strong px-4 py-2 text-sm font-medium transition-colors hover:bg-sunken"
            >
              Not now
            </button>
            <button
              onClick={sendCode}
              disabled={busy}
              className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-ink/88 disabled:opacity-60"
            >
              {busy ? 'Sending' : 'Send me a code'}
            </button>
          </div>
        </>
      ) : (
        <>
          <input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            placeholder="123456"
            value={code}
            onChange={(e) => { setCode(e.target.value); if (error) setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') verify(); }}
            aria-invalid={!!error}
            className={`${field} tnum text-center text-lg tracking-[0.4em] ${error ? 'border-debit' : 'border-rule'}`}
          />
          {error && <p role="alert" className="text-sm text-debit">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => { setStep('email'); setCode(''); setError(''); }}
              className="rounded-full px-2 py-2 text-sm text-ink-subtle transition-colors hover:text-ink"
            >
              Use a different email
            </button>
            <button
              onClick={verify}
              disabled={busy}
              className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-ink/88 disabled:opacity-60"
            >
              {busy ? 'Checking' : 'Sign in'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
