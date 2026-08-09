import { tripToPayload, remoteToTrip, RemoteTrip, TripPayload } from './rows';
import { sampleTrip, Trip } from '../App';

// Stands in for what Postgres gives back: the payload plus the server's
// updated_at, with embedded arrays deliberately shuffled, because PostgREST
// makes no ordering promise about an embedded resource.
const asRemote = (p: TripPayload, updatedAt = '2026-02-01T00:00:00.000Z'): RemoteTrip => ({
  id: p.id,
  name: p.name,
  created_at: p.created_at,
  updated_at: updatedAt,
  members: [...p.members].reverse(),
  expenses: [...p.expenses].reverse().map((e) => ({
    id: e.id,
    title: e.title,
    payer_id: e.payer_id,
    total: e.total,
    category: e.category,
    spent_at: e.spent_at,
    position: e.position,
    splits: [...e.splits].reverse(),
    payments: e.payments ? [...e.payments].reverse() : [],
  })),
});

const roundTrip = (t: Trip): Trip => remoteToTrip(asRemote(tripToPayload(t), t.updatedAt));

const base = (over: Partial<Trip> = {}): Trip => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Goa',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  members: [
    { id: '22222222-2222-4222-8222-222222222222', name: 'Asha' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Bilal' },
  ],
  expenses: [],
  ...over,
});

describe('tripToPayload / remoteToTrip round trip', () => {
  it('survives the sample trip', () => {
    const t = { ...sampleTrip(), updatedAt: '2026-02-01T00:00:00.000Z' };
    expect(roundTrip(t)).toEqual(t);
  });

  it('survives an empty trip', () => {
    const t = base();
    expect(roundTrip(t)).toEqual(t);
  });

  it('survives a multi-payer expense', () => {
    const t = base({
      expenses: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          title: 'Hotel',
          payerId: '22222222-2222-4222-8222-222222222222',
          payers: [
            { memberId: '22222222-2222-4222-8222-222222222222', amount: 600 },
            { memberId: '33333333-3333-4333-8333-333333333333', amount: 400 },
          ],
          total: 1000,
          splits: [
            { memberId: '22222222-2222-4222-8222-222222222222', amount: 500 },
            { memberId: '33333333-3333-4333-8333-333333333333', amount: 500 },
          ],
          category: 'hotel',
          date: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    expect(roundTrip(t)).toEqual(t);
  });

  it('keeps a single-payer expense free of a payers key', () => {
    const t = base({
      expenses: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          title: 'Chai',
          payerId: '22222222-2222-4222-8222-222222222222',
          total: 40,
          splits: [{ memberId: '22222222-2222-4222-8222-222222222222', amount: 40 }],
          category: 'food',
          date: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    const out = roundTrip(t);
    expect('payers' in out.expenses[0]).toBe(false);
    expect(out).toEqual(t);
  });

  it('survives a retired member who still has money attached', () => {
    const t = base({
      members: [
        { id: '22222222-2222-4222-8222-222222222222', name: 'Asha' },
        { id: '33333333-3333-4333-8333-333333333333', name: 'Bilal', active: false },
      ],
      expenses: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          title: 'Bus',
          payerId: '33333333-3333-4333-8333-333333333333',
          total: 200,
          splits: [
            { memberId: '22222222-2222-4222-8222-222222222222', amount: 100 },
            { memberId: '33333333-3333-4333-8333-333333333333', amount: 100 },
          ],
          category: 'bus',
          date: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    expect(roundTrip(t)).toEqual(t);
  });
});

describe('remoteToTrip', () => {
  it('restores expense and member order from position, not array order', () => {
    const t = base({
      expenses: [
        { id: '44444444-4444-4444-8444-444444444444', title: 'First', payerId: '22222222-2222-4222-8222-222222222222', total: 10, splits: [{ memberId: '22222222-2222-4222-8222-222222222222', amount: 10 }], category: 'other', date: '2026-01-05T00:00:00.000Z' },
        { id: '55555555-5555-4555-8555-555555555555', title: 'Second', payerId: '22222222-2222-4222-8222-222222222222', total: 20, splits: [{ memberId: '22222222-2222-4222-8222-222222222222', amount: 20 }], category: 'other', date: '2026-01-02T00:00:00.000Z' },
      ],
    });
    // Note the dates run backwards against array order on purpose: ordering
    // by spent_at would reverse this list, which is the bug position exists
    // to prevent.
    const out = roundTrip(t);
    expect(out.expenses.map((e) => e.title)).toEqual(['First', 'Second']);
    expect(out.members.map((m) => m.name)).toEqual(['Asha', 'Bilal']);
  });

  it('coerces numeric columns that arrive as strings', () => {
    const p = tripToPayload(base({
      expenses: [
        { id: '44444444-4444-4444-8444-444444444444', title: 'Chai', payerId: '22222222-2222-4222-8222-222222222222', total: 40.5, splits: [{ memberId: '22222222-2222-4222-8222-222222222222', amount: 40.5 }], category: 'food', date: '2026-01-02T00:00:00.000Z' },
      ],
    }));
    const remote = asRemote(p);
    remote.expenses[0].total = '40.50' as unknown as number;
    remote.expenses[0].splits[0].amount = '40.50' as unknown as number;
    const out = remoteToTrip(remote);
    expect(out.expenses[0].total).toBe(40.5);
    expect(out.expenses[0].splits[0].amount).toBe(40.5);
  });

  it('takes updatedAt from the server row', () => {
    const out = remoteToTrip(asRemote(tripToPayload(base()), '2026-03-03T00:00:00.000Z'));
    expect(out.updatedAt).toBe('2026-03-03T00:00:00.000Z');
  });
});
