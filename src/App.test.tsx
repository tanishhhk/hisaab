import React from 'react';
import { render, screen } from '@testing-library/react';
import App, {
  allocateEqually,
  applyRemoval,
  csvCell,
  isActive,
  isEqualSplit,
  ledgerMembers,
  removalImpact,
  sampleTrip,
  Expense,
  Trip,
} from './App';

const expense = (over: Partial<Expense> = {}): Expense => ({
  id: 'e1',
  title: 'Dinner',
  payerId: 'a',
  total: 100,
  splits: [],
  category: 'food',
  date: '2026-01-01T00:00:00.000Z',
  ...over,
});

const sumPaise = (splits: { amount: number }[]): number =>
  splits.reduce((s, x) => s + Math.round(x.amount * 100), 0);

describe('allocateEqually', () => {
  it('allocates the exact total even when it does not divide evenly', () => {
    expect(sumPaise(allocateEqually(100, ['a', 'b', 'c']))).toBe(10000);
    expect(sumPaise(allocateEqually(1, ['a', 'b', 'c', 'd', 'e', 'f']))).toBe(100);
    expect(sumPaise(allocateEqually(0.05, ['a', 'b', 'c']))).toBe(5);
    expect(sumPaise(allocateEqually(1000, ['a', 'b', 'c', 'd', 'e', 'f', 'g']))).toBe(100000);
  });

  it('spreads the leftover paise one per member, never more', () => {
    const parts = allocateEqually(100, ['a', 'b', 'c']).map((s) => s.amount);
    expect(parts).toEqual([33.34, 33.33, 33.33]);
  });

  it('returns nothing when there is nobody to charge', () => {
    expect(allocateEqually(100, [])).toEqual([]);
  });
});

describe('csvCell', () => {
  it('quotes cells containing the delimiter', () => {
    expect(csvCell('Raj, Kumar')).toBe('"Raj, Kumar"');
  });

  it('doubles embedded quotes rather than emitting broken CSV', () => {
    expect(csvCell('5" nails')).toBe('"5"" nails"');
  });

  it('leaves ordinary cells unquoted', () => {
    expect(csvCell('Dinner')).toBe('Dinner');
    expect(csvCell(250)).toBe('250');
  });

  it('neutralises leading characters spreadsheets treat as formulas', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
});

describe('isEqualSplit', () => {
  it('recognises an allocation produced by allocateEqually', () => {
    expect(isEqualSplit(expense({ splits: allocateEqually(100, ['a', 'b', 'c']) }))).toBe(true);
  });

  it('recognises hand-entered uneven amounts', () => {
    expect(
      isEqualSplit(expense({ splits: [{ memberId: 'a', amount: 70 }, { memberId: 'b', amount: 30 }] }))
    ).toBe(false);
  });

  it('treats a single participant as equal', () => {
    expect(isEqualSplit(expense({ splits: [{ memberId: 'a', amount: 100 }] }))).toBe(true);
  });
});

describe('applyRemoval', () => {
  const baseTrip = (): Trip => ({
    id: 't1',
    name: 'Indore',
    members: [
      { id: 'a', name: 'Asha' },
      { id: 'b', name: 'Bilal' },
      { id: 'c', name: 'Chetan' },
    ],
    expenses: [
      expense({ id: 'equal', total: 90, splits: allocateEqually(90, ['a', 'b', 'c']) }),
      expense({
        id: 'custom',
        total: 100,
        splits: [
          { memberId: 'a', amount: 70 },
          { memberId: 'c', amount: 30 },
        ],
      }),
      expense({ id: 'sole', total: 40, payerId: 'b', splits: [{ memberId: 'c', amount: 40 }] }),
    ],
  });

  it('soft-deletes rather than dropping the member record', () => {
    const after = applyRemoval(baseTrip(), 'c', 'keep');
    const chetan = after.members.find((m) => m.id === 'c');
    expect(chetan).toBeDefined();
    expect(chetan!.name).toBe('Chetan');
    expect(isActive(chetan!)).toBe(false);
  });

  it('leaves every expense untouched in keep mode', () => {
    const before = baseTrip();
    const after = applyRemoval(before, 'c', 'keep');
    expect(after.expenses).toEqual(before.expenses);
  });

  it('re-divides equal splits across the remaining participants', () => {
    const after = applyRemoval(baseTrip(), 'c', 'redistribute');
    const equal = after.expenses.find((e) => e.id === 'equal')!;
    expect(equal.splits.map((s) => s.memberId)).toEqual(['a', 'b']);
    expect(equal.splits.map((s) => s.amount)).toEqual([45, 45]);
  });

  it('keeps redistributed expenses fully allocated against their total', () => {
    const after = applyRemoval(baseTrip(), 'c', 'redistribute');
    after.expenses.forEach((e) => {
      if (e.id === 'equal') expect(sumPaise(e.splits)).toBe(Math.round(e.total * 100));
    });
  });

  it('does not guess at custom splits', () => {
    const before = baseTrip();
    const after = applyRemoval(before, 'c', 'redistribute');
    expect(after.expenses.find((e) => e.id === 'custom')).toEqual(
      before.expenses.find((e) => e.id === 'custom')
    );
  });

  it('leaves an expense alone when the removed member was its only participant', () => {
    const before = baseTrip();
    const after = applyRemoval(before, 'c', 'redistribute');
    expect(after.expenses.find((e) => e.id === 'sole')).toEqual(
      before.expenses.find((e) => e.id === 'sole')
    );
  });

  it('reports what each mode will touch', () => {
    const impact = removalImpact(baseTrip(), 'c');
    expect(impact.involvedCount).toBe(3);
    expect(impact.redistributableCount).toBe(1);
    expect(impact.customCount).toBe(1);
    expect(impact.soleCount).toBe(1);
    expect(impact.paidCount).toBe(0);
  });
});

describe('ledgerMembers', () => {
  it('keeps a removed member who still has money attached', () => {
    const trip: Trip = {
      id: 't1',
      name: 'Indore',
      members: [
        { id: 'a', name: 'Asha' },
        { id: 'b', name: 'Bilal', active: false },
      ],
      expenses: [expense({ payerId: 'b', splits: [{ memberId: 'a', amount: 100 }] })],
    };
    expect(ledgerMembers(trip).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('drops a removed member with no financial history', () => {
    const trip: Trip = {
      id: 't1',
      name: 'Indore',
      members: [
        { id: 'a', name: 'Asha' },
        { id: 'b', name: 'Bilal', active: false },
      ],
      expenses: [],
    };
    expect(ledgerMembers(trip).map((m) => m.id)).toEqual(['a']);
  });
});

describe('sampleTrip', () => {
  it('is fully allocated, so the demo settles to zero', () => {
    const t = sampleTrip();
    t.expenses.forEach((e) => {
      expect(sumPaise(e.splits)).toBe(Math.round(e.total * 100));
    });
  });

  it('only references its own members', () => {
    const t = sampleTrip();
    const ids = t.members.map((m) => m.id);
    t.expenses.forEach((e) => {
      expect(ids).toContain(e.payerId);
      e.splits.forEach((s) => expect(ids).toContain(s.memberId));
    });
  });

  it('mints fresh ids on every call so two samples never collide', () => {
    expect(sampleTrip().id).not.toBe(sampleTrip().id);
  });
});

describe('App', () => {
  beforeEach(() => localStorage.clear());

  it('offers both a real start and a worked example when there are no trips', () => {
    render(<App />);
    expect(screen.getByText('Trip Expense Manager')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create your first trip/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try a sample trip/i })).toBeInTheDocument();
  });
});
