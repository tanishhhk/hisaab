import React from 'react';
import { SyncPhase } from './sync/useSync';

// This replaces a static sentence that promised "Saved in this browser only".
// That promise becomes false the moment someone signs in, and a stale honesty
// claim is worse than none: it is the line someone reads just before deciding
// not to export a backup.
export default function SyncStatus({
  phase,
  onRetry,
  onSignIn,
}: {
  phase: SyncPhase;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  const text: Record<SyncPhase, string> = {
    local: 'Saved in this browser. It will not follow you to another device.',
    saving: 'Saving…',
    synced: 'Synced to your account.',
    offline: 'Offline — your changes will sync when you reconnect.',
    error: 'Could not save.',
    auth: 'Your session expired.',
  };

  const action =
    phase === 'error'
      ? { label: 'Retry', run: onRetry }
      : phase === 'auth'
      ? { label: 'Sign in', run: onSignIn }
      : null;

  return (
    // polite, not assertive: this should never interrupt someone mid-entry.
    <p role="status" aria-live="polite" className="mt-1 flex items-center gap-2 text-sm text-ink-subtle">
      <span>{text[phase]}</span>
      {action && (
        <button
          type="button"
          onClick={action.run}
          className="rounded-full px-2 py-0.5 text-sm font-medium text-ink underline underline-offset-2 transition-colors hover:bg-sunken"
        >
          {action.label}
        </button>
      )}
    </p>
  );
}
