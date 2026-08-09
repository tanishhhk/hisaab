import { reconcile, SyncState, tripKey, memberKey, expenseKey } from './reconcile';
import { Trip, Member, Expense } from '../App';

const clean: SyncState = { dirty: [], deleted: [] };

const member = (id: string, over: Partial<Member> = {}): Member => ({
  id,
  name: id,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const expense = (id: string, over: Partial<Expense> = {}): Expense => ({
  id,
  title: id,
  payerId: 'm1',
  total: 100,
  splits: [{ memberId: 'm1', amount: 100 }],
  category: 'food',
  date: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const trip = (id: string, over: Partial<Trip> = {}): Trip => ({
  id,
  name: id,
  members: [],
  expenses: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('reconcile, trip level', () => {
  it('keeps a local-only trip and queues it with everything inside it', () => {
    const t = trip('a', { members: [member('m1')], expenses: [expense('e1')] });
    const r = reconcile([t], [], clean);
    expect(r.trips.map((x) => x.id)).toEqual(['a']);
    // The trip row alone is not enough: the server has seen none of it.
    expect(r.toPush).toEqual([tripKey('a'), memberKey('m1'), expenseKey('e1')]);
  });

  it('adopts a remote-only trip without queueing a push', () => {
    const r = reconcile([], [trip('b', { name: 'From phone' })], clean);
    expect(r.trips.map((x) => x.name)).toEqual(['From phone']);
    expect(r.toPush).toEqual([]);
  });

  it('lets the newer trip stamp win when both are clean', () => {
    const r = reconcile(
      [trip('a', { name: 'stale' })],
      [trip('a', { name: 'fresh', updatedAt: '2026-05-05T00:00:00.000Z' })],
      clean
    );
    expect(r.trips[0].name).toBe('fresh');
    expect(r.toPush).toEqual([]);
  });

  it('gives a tie to remote', () => {
    const r = reconcile([trip('a', { name: 'local' })], [trip('a', { name: 'remote' })], clean);
    expect(r.trips[0].name).toBe('remote');
  });

  it('lets a dirty trip win even when remote looks newer', () => {
    const r = reconcile(
      [trip('a', { name: 'unsent' })],
      [trip('a', { name: 'partial', updatedAt: '2026-09-09T00:00:00.000Z' })],
      { dirty: [tripKey('a')], deleted: [] }
    );
    expect(r.trips[0].name).toBe('unsent');
    expect(r.toPush).toContain(tripKey('a'));
  });

  it('excludes a tombstoned trip and keeps re-queueing the delete', () => {
    const r = reconcile([trip('a')], [trip('a')], { dirty: [], deleted: [tripKey('a')] });
    expect(r.trips).toEqual([]);
    expect(r.toDelete).toEqual([tripKey('a')]);
    expect(r.toPush).toEqual([]);
  });

  it('orders the merged list newest-first by createdAt', () => {
    const r = reconcile(
      [trip('old')],
      [trip('new', { createdAt: '2026-06-01T00:00:00.000Z' })],
      clean
    );
    expect(r.trips.map((t) => t.id)).toEqual(['new', 'old']);
  });
});

describe('reconcile, entity level', () => {
  it('keeps both when two people added different expenses', () => {
    // The whole point of the change. Under whole-trip sync one of these
    // would have overwritten the other.
    const mine = trip('a', { expenses: [expense('mine')] });
    const theirs = trip('a', { expenses: [expense('theirs')] });
    const r = reconcile([mine], [theirs], { dirty: [expenseKey('mine')], deleted: [] });
    expect(r.trips[0].expenses.map((e) => e.id).sort()).toEqual(['mine', 'theirs']);
    expect(r.toPush).toContain(expenseKey('mine'));
  });

  it('drops an expense someone else deleted', () => {
    // Local, clean, absent from the server. Clean means the server had it,
    // so its absence is a deletion rather than a push we still owe.
    const mine = trip('a', { expenses: [expense('gone')] });
    const theirs = trip('a', { expenses: [] });
    const r = reconcile([mine], [theirs], clean);
    expect(r.trips[0].expenses).toEqual([]);
  });

  it('keeps an unsent local expense that the server has never seen', () => {
    const mine = trip('a', { expenses: [expense('new')] });
    const theirs = trip('a', { expenses: [] });
    const r = reconcile([mine], [theirs], { dirty: [expenseKey('new')], deleted: [] });
    expect(r.trips[0].expenses.map((e) => e.id)).toEqual(['new']);
    expect(r.toPush).toContain(expenseKey('new'));
  });

  it('lets the newer edit of one expense win', () => {
    const mine = trip('a', { expenses: [expense('e1', { title: 'stale' })] });
    const theirs = trip('a', {
      expenses: [expense('e1', { title: 'fresh', updatedAt: '2026-07-07T00:00:00.000Z' })],
    });
    const r = reconcile([mine], [theirs], clean);
    expect(r.trips[0].expenses[0].title).toBe('fresh');
  });

  it('lets a dirty expense win over a newer remote one', () => {
    const mine = trip('a', { expenses: [expense('e1', { title: 'unsent' })] });
    const theirs = trip('a', {
      expenses: [expense('e1', { title: 'server', updatedAt: '2026-09-09T00:00:00.000Z' })],
    });
    const r = reconcile([mine], [theirs], { dirty: [expenseKey('e1')], deleted: [] });
    expect(r.trips[0].expenses[0].title).toBe('unsent');
    expect(r.toPush).toContain(expenseKey('e1'));
  });

  it('excludes a tombstoned member and keeps re-queueing that delete', () => {
    const mine = trip('a', { members: [member('m1'), member('m2')] });
    const theirs = trip('a', { members: [member('m1'), member('m2')] });
    const r = reconcile([mine], [theirs], { dirty: [], deleted: [memberKey('m2')] });
    expect(r.trips[0].members.map((m) => m.id)).toEqual(['m1']);
    expect(r.toDelete).toEqual([memberKey('m2')]);
  });

  it('adopts a member added by someone else', () => {
    const mine = trip('a', { members: [member('m1')] });
    const theirs = trip('a', { members: [member('m1'), member('m2', { name: 'Divya' })] });
    const r = reconcile([mine], [theirs], clean);
    expect(r.trips[0].members.map((m) => m.name).sort()).toEqual(['Divya', 'm1']);
  });
});
