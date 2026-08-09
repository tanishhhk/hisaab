import { useCallback, useEffect, useRef, useState } from 'react';
import { Trip } from '../App';
import { isBackendConfigured } from '../supabase';
import { syncKey } from './ids';
import { reconcile, SyncState } from './reconcile';
import { pullTrips, pushTrip, deleteTrip } from './remote';

export type SyncPhase = 'local' | 'saving' | 'synced' | 'offline' | 'error' | 'auth';

export interface Sync {
  phase: SyncPhase;
  // False only while the very first pull is in flight with nothing local to
  // show. This is what stops EmptyState claiming "no trips" to someone who
  // has a dozen in the cloud.
  hydrated: boolean;
  // True once the pull has run long enough to be worth showing placeholders
  // for. A skeleton that flashes for 150ms is worse than none.
  skeleton: boolean;
  pullFailed: boolean;
  retry: () => void;
  markDirty: (id: string) => void;
  markDeleted: (id: string) => void;
}

const DEBOUNCE_MS = 900;
const SAVING_GRACE_MS = 400;
const SKELETON_DELAY_MS = 200;
const BACKOFF_MS = [2000, 5000, 15000, 30000];

const readState = (userId: string): SyncState => {
  try {
    const raw = localStorage.getItem(syncKey(userId));
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      dirty: Array.isArray(parsed?.dirty) ? parsed.dirty : [],
      deleted: Array.isArray(parsed?.deleted) ? parsed.deleted : [],
    };
  } catch (e) {
    return { dirty: [], deleted: [] };
  }
};

const writeState = (userId: string, s: SyncState): void => {
  try {
    localStorage.setItem(syncKey(userId), JSON.stringify(s));
  } catch (e) {
    /* storage blocked or full; the in-memory copy still drives this session */
  }
};

export function useSync(
  userId: string | null,
  trips: Trip[],
  setTrips: React.Dispatch<React.SetStateAction<Trip[]>>
): Sync {
  const active = !!userId && isBackendConfigured;

  const [phase, setPhase] = useState<SyncPhase>('local');
  const [hydrated, setHydrated] = useState<boolean>(!active);
  const [pullSlow, setPullSlow] = useState<boolean>(false);
  const [pullFailed, setPullFailed] = useState<boolean>(false);

  // Refs, not state: the flush loop reads these on a timer and must see the
  // latest value without re-subscribing on every render.
  const stateRef = useRef<SyncState>({ dirty: [], deleted: [] });
  const tripsRef = useRef<Trip[]>(trips);
  const flushing = useRef<boolean>(false);
  const attempt = useRef<number>(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // flush and schedule call each other, so one of them has to be reached
  // through a ref or the const is read before it is initialised.
  const flushRef = useRef<() => void>(() => {});

  tripsRef.current = trips;

  const persist = useCallback(() => {
    if (userId) writeState(userId, stateRef.current);
  }, [userId]);

  const schedule = useCallback((delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      flushRef.current();
    }, delay);
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    if (!active || flushing.current) return;
    const { dirty, deleted } = stateRef.current;
    if (dirty.length === 0 && deleted.length === 0) {
      setPhase('synced');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setPhase('offline');
      return;
    }

    flushing.current = true;
    // Only claim to be saving if it is taking long enough to be worth saying.
    // A fast push should leave the header alone rather than blink on every
    // keystroke.
    savingTimer.current = setTimeout(() => setPhase('saving'), SAVING_GRACE_MS);

    let failure: 'network' | 'auth' | 'db' | null = null;

    for (const id of [...deleted]) {
      const r = await deleteTrip(id);
      if (r.ok) {
        stateRef.current.deleted = stateRef.current.deleted.filter((x: string) => x !== id);
      } else {
        failure = r.kind;
        break;
      }
    }

    if (!failure) {
      for (const id of [...dirty]) {
        const trip = tripsRef.current.find((t: Trip) => t.id === id);
        if (!trip) {
          stateRef.current.dirty = stateRef.current.dirty.filter((x: string) => x !== id);
          continue;
        }
        const r = await pushTrip(trip);
        if (r.ok) {
          // Take the server's stamp. A local guess would lose to the
          // trips_touch trigger and re-pull forever.
          setTrips((prev: Trip[]) =>
            prev.map((t: Trip) => (t.id === id ? { ...t, updatedAt: r.value } : t))
          );
          stateRef.current.dirty = stateRef.current.dirty.filter((x: string) => x !== id);
        } else {
          failure = r.kind;
          break;
        }
      }
    }

    if (savingTimer.current) {
      clearTimeout(savingTimer.current);
      savingTimer.current = null;
    }
    persist();
    flushing.current = false;

    if (!failure) {
      attempt.current = 0;
      setPhase('synced');
      return;
    }

    setPhase(failure === 'auth' ? 'auth' : failure === 'network' ? 'offline' : 'error');
    // An expired session will not fix itself on a timer, so do not spin.
    if (failure !== 'auth') {
      const delay = BACKOFF_MS[Math.min(attempt.current, BACKOFF_MS.length - 1)];
      attempt.current += 1;
      schedule(delay);
    }
  }, [active, persist, schedule, setTrips]);

  flushRef.current = () => {
    void flush();
  };

  const markDirty = useCallback(
    (id: string) => {
      if (!active) return;
      if (!stateRef.current.dirty.includes(id)) {
        stateRef.current.dirty = [...stateRef.current.dirty, id];
      }
      persist();
      schedule(DEBOUNCE_MS);
    },
    [active, persist, schedule]
  );

  const markDeleted = useCallback(
    (id: string) => {
      if (!active) return;
      stateRef.current.dirty = stateRef.current.dirty.filter((x: string) => x !== id);
      if (!stateRef.current.deleted.includes(id)) {
        stateRef.current.deleted = [...stateRef.current.deleted, id];
      }
      persist();
      schedule(DEBOUNCE_MS);
    },
    [active, persist, schedule]
  );

  const retry = useCallback(() => {
    attempt.current = 0;
    void flush();
  }, [flush]);

  // First pull. Local state is already on screen by now; this only merges.
  useEffect(() => {
    if (!active || !userId) {
      setHydrated(true);
      setPullSlow(false);
      setPhase('local');
      setPullFailed(false);
      return;
    }
    let alive = true;
    stateRef.current = readState(userId);
    setHydrated(false);
    setPullSlow(false);
    setPullFailed(false);
    // Only admit to loading once it is actually slow enough to notice.
    const slow = setTimeout(() => setPullSlow(true), SKELETON_DELAY_MS);

    void (async () => {
      const r = await pullTrips();
      if (!alive) return;
      clearTimeout(slow);
      if (!r.ok) {
        setPullFailed(true);
        setHydrated(true);
        setPhase(r.kind === 'auth' ? 'auth' : r.kind === 'network' ? 'offline' : 'error');
        return;
      }
      setTrips((prev: Trip[]) => {
        const merged = reconcile(prev, r.value, stateRef.current);
        stateRef.current = { dirty: merged.toPush, deleted: merged.toDelete };
        writeState(userId, stateRef.current);
        return merged.trips;
      });
      setHydrated(true);
      // Give React the merged state before the flush reads tripsRef.
      setTimeout(() => flushRef.current(), 0);
    })();

    return () => {
      alive = false;
      clearTimeout(slow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, userId]);

  // Coming back online is the one event worth reacting to immediately: the
  // backoff timer could be 30 seconds away from a push that would now work.
  useEffect(() => {
    if (!active) return;
    const onOnline = () => {
      attempt.current = 0;
      flushRef.current();
    };
    const onOffline = () => setPhase('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [active]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (savingTimer.current) clearTimeout(savingTimer.current);
    },
    []
  );

  return {
    phase: active ? phase : 'local',
    hydrated,
    skeleton: !hydrated && pullSlow,
    pullFailed,
    retry,
    markDirty,
    markDeleted,
  };
}
