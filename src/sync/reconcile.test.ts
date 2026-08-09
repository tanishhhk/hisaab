import { reconcile, SyncState } from './reconcile';
import { Trip } from '../App';

const trip = (id: string, over: Partial<Trip> = {}): Trip => ({
  id,
  name: id,
  members: [],
  expenses: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const clean: SyncState = { dirty: [], deleted: [] };

describe('reconcile', () => {
  it('keeps a local-only trip and queues it for push', () => {
    const r = reconcile([trip('a')], [], clean);
    expect(r.trips.map((t) => t.id)).toEqual(['a']);
    expect(r.toPush).toEqual(['a']);
  });

  it('adopts a remote-only trip without queueing a push', () => {
    const r = reconcile([], [trip('b', { name: 'From phone' })], clean);
    expect(r.trips.map((t) => t.name)).toEqual(['From phone']);
    expect(r.toPush).toEqual([]);
  });

  it('lets the newer stamp win when both are clean', () => {
    const r = reconcile(
      [trip('a', { name: 'stale', updatedAt: '2026-01-01T00:00:00.000Z' })],
      [trip('a', { name: 'fresh', updatedAt: '2026-05-05T00:00:00.000Z' })],
      clean
    );
    expect(r.trips[0].name).toBe('fresh');
    expect(r.toPush).toEqual([]);
  });

  it('lets local win when local is newer, and queues the push', () => {
    const r = reconcile(
      [trip('a', { name: 'fresh', updatedAt: '2026-05-05T00:00:00.000Z' })],
      [trip('a', { name: 'stale', updatedAt: '2026-01-01T00:00:00.000Z' })],
      clean
    );
    expect(r.trips[0].name).toBe('fresh');
    expect(r.toPush).toEqual(['a']);
  });

  it('gives a tie to remote', () => {
    const r = reconcile(
      [trip('a', { name: 'local' })],
      [trip('a', { name: 'remote' })],
      clean
    );
    expect(r.trips[0].name).toBe('remote');
  });

  it('lets a dirty local trip win even when remote looks newer', () => {
    // The guard against a failed push: an incomplete remote copy must never
    // be adopted over the complete local one.
    const r = reconcile(
      [trip('a', { name: 'unsent', updatedAt: '2026-01-01T00:00:00.000Z' })],
      [trip('a', { name: 'partial', updatedAt: '2026-09-09T00:00:00.000Z' })],
      { dirty: ['a'], deleted: [] }
    );
    expect(r.trips[0].name).toBe('unsent');
    expect(r.toPush).toEqual(['a']);
  });

  it('treats a missing local updatedAt as never synced', () => {
    const local = trip('a', { name: 'local' });
    delete local.updatedAt;
    const r = reconcile([local], [trip('a', { name: 'remote' })], clean);
    expect(r.trips[0].name).toBe('remote');
  });

  it('excludes a tombstoned trip and keeps re-queueing the delete', () => {
    const r = reconcile([], [trip('a')], { dirty: [], deleted: ['a'] });
    expect(r.trips).toEqual([]);
    expect(r.toDelete).toEqual(['a']);
  });

  it('keeps a tombstoned trip out even when it is still local', () => {
    const r = reconcile([trip('a')], [trip('a')], { dirty: [], deleted: ['a'] });
    expect(r.trips).toEqual([]);
    expect(r.toPush).toEqual([]);
    expect(r.toDelete).toEqual(['a']);
  });

  it('orders the merged list newest-first by createdAt', () => {
    const r = reconcile(
      [trip('old', { createdAt: '2026-01-01T00:00:00.000Z' })],
      [trip('new', { createdAt: '2026-06-01T00:00:00.000Z' })],
      clean
    );
    expect(r.trips.map((t) => t.id)).toEqual(['new', 'old']);
  });

  it('sorts a trip with no createdAt after one that has it', () => {
    // Fed to the sort in this order (no-date before has-date) so a
    // NaN-comparator bug — which tends to leave the array untouched — would
    // fail this assertion instead of passing it by accident.
    const noDate = trip('no-date');
    delete noDate.createdAt;
    const hasDate = trip('has-date', { createdAt: '2026-01-01T00:00:00.000Z' });
    const r = reconcile([noDate, hasDate], [], clean);
    expect(r.trips.map((t) => t.id)).toEqual(['has-date', 'no-date']);
  });
});
