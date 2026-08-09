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
  const info: Record<SyncPhase, { text: string; icon: React.ReactNode; color: string }> = {
    local: {
      text: 'Not backed up',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
      ),
      color: 'text-amber-600 dark:text-amber-400'
    },
    saving: {
      text: 'Saving...',
      icon: (
        <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
      ),
      color: 'text-ink-subtle'
    },
    synced: {
      text: 'Synced',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
      ),
      color: 'text-green-600 dark:text-green-400'
    },
    offline: {
      text: 'Offline',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" /></svg>
      ),
      color: 'text-amber-500'
    },
    error: {
      text: 'Error saving',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      ),
      color: 'text-red-500'
    },
    auth: {
      text: 'Session expired',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
      ),
      color: 'text-amber-500'
    }
  };

  const action =
    phase === 'error'
      ? { label: 'Retry', run: onRetry }
      : (phase === 'auth' || phase === 'local')
      ? { label: 'Sign in to sync', run: onSignIn }
      : null;

  const currentInfo = info[phase];

  if (phase === 'local') return null;

  return (
    <div className={`flex items-center gap-1.5 text-xs font-medium ${currentInfo.color}`} title={currentInfo.text}>
      {currentInfo.icon}
      <span className="hidden sm:inline-block">{currentInfo.text}</span>
      {action && (
        <button
          type="button"
          onClick={action.run}
          className="ml-2 rounded-full bg-accent px-3 py-1 text-[10px] font-bold text-canvas uppercase tracking-widest hover:bg-accent-strong transition-colors shadow-sm"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
