import { Trip, Member, Expense } from '../App';

// Sync keys. One string namespace for trips, members and expenses, because
// the dirty and tombstone sets have to hold all three and a key collision
// between a member and an expense sharing a uuid would be silent.
export const tripKey = (id: string) => `trip:${id}`;
export const memberKey = (id: string) => `member:${id}`;
export const expenseKey = (id: string) => `expense:${id}`;

export interface SyncState {
  // Entities changed locally and not yet confirmed by the server. Persisted,
  // so a reload while offline does not forget unsent work.
  dirty: string[];
  // Tombstones, kept until the server confirms the delete. Without them an
  // offline delete is undone by the next pull.
  deleted: string[];
}

export interface Reconciled {
  trips: Trip[];
  toPush: string[];
  toDelete: string[];
}

const at = (v: string | undefined): number => (v ? Date.parse(v) : 0);

// Merge one collection of members or expenses belonging to a single trip.
//
// The rule that does the real work is the third one. An entity that exists
// locally, is clean, and is absent from the server was deleted by somebody
// else: clean means the server has already seen it, so its absence now is a
// deletion rather than a push we still owe. Without that, a delete made on
// another device would come back on every pull.
function mergeEntities<T extends { id: string; updatedAt?: string }>(
  local: T[],
  remote: T[],
  key: (id: string) => string,
  dirty: Set<string>,
  deleted: Set<string>,
  toPush: string[],
  toDelete: string[]
): T[] {
  const l = new Map(local.map((e) => [e.id, e]));
  const r = new Map(remote.map((e) => [e.id, e]));
  const out: T[] = [];

  const ids = new Set<string>([...Array.from(l.keys()), ...Array.from(r.keys())]);
  ids.forEach((id) => {
    const k = key(id);
    if (deleted.has(k)) {
      toDelete.push(k);
      return;
    }
    const mine = l.get(id);
    const theirs = r.get(id);

    if (mine && !theirs) {
      if (dirty.has(k)) {
        out.push(mine);
        toPush.push(k);
      }
      // else: deleted on another device. Dropping it is the merge.
      return;
    }
    if (!mine && theirs) {
      out.push(theirs);
      return;
    }
    if (!mine || !theirs) return;

    // An unfinished push means the remote copy may be stale or incomplete.
    if (dirty.has(k)) {
      out.push(mine);
      toPush.push(k);
      return;
    }
    // Ties go to remote: it is canonical and we have nothing unsent.
    if (at(mine.updatedAt) > at(theirs.updatedAt)) {
      out.push(mine);
      toPush.push(k);
    } else {
      out.push(theirs);
    }
  });

  return out;
}

export function reconcile(local: Trip[], remote: Trip[], state: SyncState): Reconciled {
  const dirty = new Set(state.dirty);
  const deleted = new Set(state.deleted);
  const l = new Map(local.map((t: Trip) => [t.id, t]));
  const r = new Map(remote.map((t: Trip) => [t.id, t]));

  const trips: Trip[] = [];
  const toPush: string[] = [];
  const toDelete: string[] = [];

  const ids = new Set<string>([...Array.from(l.keys()), ...Array.from(r.keys())]);

  ids.forEach((id: string) => {
    const k = tripKey(id);
    if (deleted.has(k)) {
      toDelete.push(k);
      return;
    }

    const mine = l.get(id);
    const theirs = r.get(id);

    // A trip the server has never seen. Everything inside it is unsent too,
    // so queue the trip and each of its entities rather than only the trip.
    if (mine && !theirs) {
      trips.push(mine);
      toPush.push(k);
      mine.members.forEach((m: Member) => toPush.push(memberKey(m.id)));
      mine.expenses.forEach((e: Expense) => toPush.push(expenseKey(e.id)));
      return;
    }
    if (!mine && theirs) {
      trips.push(theirs);
      return;
    }
    if (!mine || !theirs) return;

    // The trip's own row carries only name and stamps. Its members and
    // expenses merge independently, which is the point of the whole change:
    // two people adding different expenses no longer overwrite each other.
    const meta = dirty.has(k) || at(mine.updatedAt) > at(theirs.updatedAt) ? mine : theirs;
    if (meta === mine) toPush.push(k);

    trips.push({
      ...meta,
      members: mergeEntities(mine.members, theirs.members, memberKey, dirty, deleted, toPush, toDelete),
      expenses: mergeEntities(mine.expenses, theirs.expenses, expenseKey, dirty, deleted, toPush, toDelete),
    });
  });

  trips.sort(
    (a: Trip, b: Trip) => at(b.createdAt) - at(a.createdAt)
  );

  return { trips, toPush, toDelete };
}
