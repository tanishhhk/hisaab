import { Trip, Member, Expense, Split } from '../App';

// Identity is minted by the client, not the database. A trip built offline
// needs stable ids before anything reaches Postgres, or its expenses have
// nothing for their splits to point at, and a retried push would insert
// duplicates instead of overwriting. UUIDs also survive two devices syncing
// into one account, which the previous 36 bits of Math.random() did not.
export function newId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // jsdom and plain-HTTP origins reach here. Weaker, but never the path a
  // real browser on HTTPS or localhost takes.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch: string) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID.test(v);
}

// Trips saved before this change carry `m_x8f2ka` style ids, which the uuid
// primary keys will not accept. Rewriting them is only safe if every
// reference moves with them, so this runs one map per trip and routes every
// id through it.
//
// Anchored to a fixed past instant rather than Date.now() so a second run
// produces identical output, which is what makes the whole function
// idempotent and therefore safe to call on every load.
const ANCHOR = Date.parse('2020-01-01T00:00:00.000Z');

export function migrateLegacyIds(trips: Trip[]): Trip[] {
  const needsIds = trips.some(
    (t: Trip) =>
      !isUuid(t.id) ||
      t.members.some((m: Member) => !isUuid(m.id)) ||
      t.expenses.some((e: Expense) => !isUuid(e.id))
  );
  const needsStamps = trips.some((t: Trip) => !t.createdAt);
  if (!needsIds && !needsStamps) return trips;

  return trips.map((t: Trip, i: number) => {
    const map = new Map<string, string>();
    const id = (old: string): string => {
      if (isUuid(old)) return old;
      let next = map.get(old);
      if (!next) {
        next = newId();
        map.set(old, next);
      }
      return next;
    };

    const expenses = t.expenses.map((e: Expense) => {
      const migrated: Expense = {
        ...e,
        id: id(e.id),
        payerId: id(e.payerId),
        splits: e.splits.map((s: Split) => ({ ...s, memberId: id(s.memberId) })),
      };
      // Absent must stay absent: payersOf() reads its absence as "one payer
      // covered the whole total", and a `payers: undefined` key would also
      // break round-trip equality against the server.
      if (e.payers) {
        migrated.payers = e.payers.map((p: Split) => ({ ...p, memberId: id(p.memberId) }));
      }
      return migrated;
    });

    return {
      ...t,
      id: id(t.id),
      // The trip list renders newest-first from array order alone, so index 0
      // must sort above index 1. A descending synthetic sequence reproduces
      // each user's existing order exactly rather than guessing from dates.
      createdAt: t.createdAt ?? new Date(ANCHOR - i * 1000).toISOString(),
      members: t.members.map((m: Member) => ({ ...m, id: id(m.id) })),
      expenses,
    };
  });
}

// Two accounts on one browser must never see each other's trips, and signing
// out must not destroy the anonymous store. Separate keys give both for free:
// there is no code path that can read the wrong one, because the wrong one is
// not the key being read.
export function tripsKey(userId: string | null): string {
  return userId ? `trips_v1:${userId}` : 'trips_v1';
}

export function syncKey(userId: string): string {
  return `hisaab_sync:${userId}`;
}
