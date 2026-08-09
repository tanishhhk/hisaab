import { newId, isUuid, migrateLegacyIds } from './ids';
import { Trip } from '../App';

const legacy = (): Trip => ({
  id: 't_aaa1',
  name: 'Goa',
  members: [
    { id: 'm_asha', name: 'Asha' },
    { id: 'm_bilal', name: 'Bilal', active: false },
  ],
  expenses: [
    {
      id: 'e_hotel',
      title: 'Hotel',
      payerId: 'm_asha',
      payers: [
        { memberId: 'm_asha', amount: 600 },
        { memberId: 'm_bilal', amount: 400 },
      ],
      total: 1000,
      splits: [
        { memberId: 'm_asha', amount: 500 },
        { memberId: 'm_bilal', amount: 500 },
      ],
      category: 'hotel',
      date: '2026-01-01T00:00:00.000Z',
    },
  ],
});

describe('newId', () => {
  it('produces a v4 uuid', () => {
    expect(isUuid(newId())).toBe(true);
  });

  it('does not repeat across a large batch', () => {
    const ids = new Set(Array.from({ length: 2000 }, newId));
    expect(ids.size).toBe(2000);
  });
});

describe('isUuid', () => {
  it('rejects the old uid() shape', () => {
    expect(isUuid('m_x8f2ka')).toBe(false);
  });
});

describe('migrateLegacyIds', () => {
  it('rewrites every id to a uuid', () => {
    const [t] = migrateLegacyIds([legacy()]);
    expect(isUuid(t.id)).toBe(true);
    expect(t.members.every((m) => isUuid(m.id))).toBe(true);
    expect(t.expenses.every((e) => isUuid(e.id))).toBe(true);
  });

  it('remaps every reference in lockstep, leaving no danglers', () => {
    const [t] = migrateLegacyIds([legacy()]);
    const known = new Set(t.members.map((m) => m.id));
    for (const e of t.expenses) {
      expect(known.has(e.payerId)).toBe(true);
      for (const p of e.payers ?? []) expect(known.has(p.memberId)).toBe(true);
      for (const s of e.splits) expect(known.has(s.memberId)).toBe(true);
    }
  });

  it('keeps the same member behind each reference', () => {
    const before = legacy();
    const [after] = migrateLegacyIds([before]);
    // Asha paid 600 and owes 500 before; whoever Asha became must still do so.
    const asha = after.members.find((m) => m.name === 'Asha')!;
    const e = after.expenses[0];
    expect(e.payerId).toBe(asha.id);
    expect(e.payers!.find((p) => p.memberId === asha.id)!.amount).toBe(600);
    expect(e.splits.find((s) => s.memberId === asha.id)!.amount).toBe(500);
  });

  it('preserves soft-delete state', () => {
    const [t] = migrateLegacyIds([legacy()]);
    expect(t.members.find((m) => m.name === 'Bilal')!.active).toBe(false);
  });

  it('backfills createdAt so array order is preserved as newest-first', () => {
    const trips = migrateLegacyIds([
      { ...legacy(), id: 't_new', name: 'Newest' },
      { ...legacy(), id: 't_old', name: 'Oldest' },
    ]);
    expect(Date.parse(trips[0].createdAt!)).toBeGreaterThan(Date.parse(trips[1].createdAt!));
  });

  it('is idempotent and returns the same array when nothing needs doing', () => {
    const once = migrateLegacyIds([legacy()]);
    const twice = migrateLegacyIds(once);
    expect(twice).toBe(once);
    expect(twice).toEqual(once);
  });

  it('leaves an expense without payers without a payers key', () => {
    const t = legacy();
    delete t.expenses[0].payers;
    const [out] = migrateLegacyIds([t]);
    expect('payers' in out.expenses[0]).toBe(false);
  });
});
