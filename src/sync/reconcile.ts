import { Trip } from '../App';

export interface SyncState {
  // Trips changed locally and not yet confirmed by the server. Persisted, so
  // a reload while offline does not forget unsent work.
  dirty: string[];
  // Tombstones. Without them, a trip that is remote-but-not-local is
  // ambiguous between "deleted here" and "created on another device".
  deleted: string[];
}

export interface Reconciled {
  trips: Trip[];
  toPush: string[];
  toDelete: string[];
}

const stamp = (t: Trip | undefined): number =>
  t?.updatedAt ? Date.parse(t.updatedAt) : 0;

export function reconcile(local: Trip[], remote: Trip[], state: SyncState): Reconciled {
  const dirty = new Set(state.dirty);
  const deleted = new Set(state.deleted);
  const byId = (list: Trip[]) => new Map(list.map((t: Trip) => [t.id, t]));
  const l = byId(local);
  const r = byId(remote);

  const trips: Trip[] = [];
  const toPush: string[] = [];
  const toDelete: string[] = [];

  const ids = new Set<string>([...Array.from(l.keys()), ...Array.from(r.keys())]);

  ids.forEach((id: string) => {
    // A tombstone outranks everything. It stays queued until the server
    // confirms, so an offline delete is not silently undone by the next pull.
    if (deleted.has(id)) {
      toDelete.push(id);
      return;
    }

    const mine = l.get(id);
    const theirs = r.get(id);

    if (mine && !theirs) {
      trips.push(mine);
      toPush.push(id);
      return;
    }
    if (!mine && theirs) {
      trips.push(theirs);
      return;
    }
    if (!mine || !theirs) return;

    // An unfinished push means the remote copy may be incomplete. Local wins
    // regardless of stamps, and gets pushed again.
    if (dirty.has(id)) {
      trips.push(mine);
      toPush.push(id);
      return;
    }

    // Ties go to remote: it is canonical and we have nothing unsent.
    if (stamp(mine) > stamp(theirs)) {
      trips.push(mine);
      toPush.push(id);
    } else {
      trips.push(theirs);
    }
  });

  trips.sort(
    (a: Trip, b: Trip) =>
      Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')
  );

  return { trips, toPush, toDelete };
}
