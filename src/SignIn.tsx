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

// Google's mark, in its own colours, because an OAuth button that restyles a
// provider's logo reads as a phishing page rather than a sign-in.
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden className="h-[18px] w-[18px]">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
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

  // One tap, no email round trip, and nothing for the person to read, copy or
  // mistype. This is the path almost everyone should take; the email code
  // stays for anyone without a Google account.
  const withGoogle = async () => {
    if (!supabase) return setError('Sign in is not available right now.');
    setBusy(true);
    setError('');
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/app` },
    });
    // Only reached if the redirect never happens; on success the page leaves.
    if (err) {
      setBusy(false);
      setError(err.message);
    }
  };

  const sendCode = async () => {
    const trimmed = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) return setError('That does not look like an email address.');
    if (!supabase) return setError('Sign in is not available right now.');
    setBusy(true);
    setError('');
    const { error: err } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        shouldCreateUser: true,
        // Without this, the link in the email goes to whatever Site URL is set
        // in the Supabase dashboard, which defaults to localhost:3000 and is a
        // single global value. Deriving it from the current origin means a
        // link opened from production returns to production and one opened in
        // development returns to development. The origin still has to be on
        // Supabase's redirect allow-list, which is what stops this being an
        // open redirect.
        emailRedirectTo: `${window.location.origin}/app`,
      },
    });
    setBusy(false);
    if (err) return setError(err.message);
    setStep('code');
  };

  // Supabase issues the token under one of two types and does not tell the
  // client which. A returning address gets `email`; a first-time address, which
  // signInWithOtp creates because shouldCreateUser is on, gets `signup`. The
  // digits look identical either way, so the only way to know is to try.
  //
  // Ordered `email` first because that is the common case once someone has an
  // account, and a wrong type fails cleanly rather than consuming the token.
  const verify = async () => {
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) return setError('The code is six digits.');
    if (!supabase) return setError('Sign in is not available right now.');
    setBusy(true);
    setError('');

    let lastError = null;
    for (const type of ['email', 'signup'] as const) {
      const { error: err } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: digits,
        type,
      });
      if (!err) {
        setBusy(false);
        onSignedIn();
        return;
      }
      lastError = err;
    }

    setBusy(false);
    // Expiry is worth naming separately: the code is right, it is just old, and
    // the recovery is different from retyping it.
    setError(
      /expired/i.test(lastError?.message ?? '')
        ? 'That code has expired. Send a new one.'
        : 'That code did not work. Check it, or send a new one.'
    );
  };

  const field =
    'w-full rounded-full border bg-surface px-4 py-2.5 text-sm transition focus:border-accent';

  return (
    <div className="space-y-4">
      <div>
        <h3 id="signin-title" className="font-display text-xl tracking-tight">
          {step === 'email' ? 'Sign in to Hisaab' : 'Check your email'}
        </h3>
        {/* Supabase mints a link and a code on every request, and which one
            lands in the inbox is decided by the email template rather than by
            this app. Naming both keeps the screen honest under either setting,
            and means switching the template later needs no change here. */}
        <p className="mt-1 text-sm text-ink-muted">
          {step === 'email'
            ? reason || 'One tap with Google, or an emailed code. No password to remember.'
            : `Sent to ${email.trim()}. Tap the link in it, or type the code below if that is what arrived. Either expires in an hour.`}
        </p>
      </div>

      {step === 'email' ? (
        <>
          <button
            onClick={withGoogle}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2.5 rounded-full border border-rule-strong bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:bg-sunken disabled:opacity-60"
          >
            <GoogleMark />
            Continue with Google
          </button>

          <div className="flex items-center gap-3 text-xs text-ink-subtle">
            <span aria-hidden className="h-px flex-1 bg-rule" />
            or use email
            <span aria-hidden className="h-px flex-1 bg-rule" />
          </div>

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
              {busy ? 'Sending' : 'Email me'}
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
          {/* The link route needs no input at all, so the code field must not
              look like the only way through. */}
          <p className="text-xs text-ink-subtle">
            Tapped the link instead? You are already signed in. Close this.
          </p>
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
