import { Trip, Member, Expense, Split } from '../App';

// The wire shapes. snake_case because these cross into Postgres unchanged;
// the camelCase types in App.tsx stay the app's own vocabulary.

export interface AmountRow {
  member_id: string;
  amount: number;
}

export interface MemberPayload {
  id: string;
  name: string;
  active: boolean;
  position: number;
}

export interface ExpensePayload {
  id: string;
  title: string;
  payer_id: string;
  total: number;
  category: string;
  spent_at: string;
  position: number;
  splits: AmountRow[];
  // null, not [], when one person paid the whole total. The distinction is
  // load-bearing: payersOf() reads an absent payers list as "payerId covered
  // everything", so flattening it to [] would lose that meaning on the way
  // back.
  payments: AmountRow[] | null;
}

export interface TripPayload {
  id: string;
  name: string;
  created_at: string;
  members: MemberPayload[];
  expenses: ExpensePayload[];
}

// What the nested select in remote.ts returns. Same as the payload plus the
// server's stamps, and with payments always an array because PostgREST
// returns an empty embedded resource as [].
export interface RemoteTrip {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  members: MemberPayload[];
  expenses: (Omit<ExpensePayload, 'payments'> & { payments: AmountRow[] })[];
}

// numeric(12,2) can arrive as a JSON number or a string depending on the
// PostgREST version and column size. Coercing once here keeps every consumer
// from having to care.
const num = (v: number | string): number => Number(v);

const byPosition = <T extends { position: number }>(a: T, b: T): number => a.position - b.position;

export function tripToPayload(trip: Trip): TripPayload {
  return {
    id: trip.id,
    name: trip.name,
    created_at: trip.createdAt ?? new Date().toISOString(),
    members: trip.members.map((m: Member, i: number) => ({
      id: m.id,
      name: m.name,
      // Absent means active, per isActive(). The column is NOT NULL, so the
      // default has to be resolved here rather than in SQL.
      active: m.active !== false,
      position: i,
    })),
    expenses: trip.expenses.map((e: Expense, i: number) => ({
      id: e.id,
      title: e.title,
      payer_id: e.payerId,
      total: Number(e.total),
      category: e.category,
      spent_at: e.date,
      position: i,
      splits: e.splits.map((s: Split) => ({ member_id: s.memberId, amount: Number(s.amount) })),
      payments: e.payers
        ? e.payers.map((p: Split) => ({ member_id: p.memberId, amount: Number(p.amount) }))
        : null,
    })),
  };
}

export function remoteToTrip(row: RemoteTrip): Trip {
  const members: Member[] = [...row.members].sort(byPosition).map((m: MemberPayload) => {
    const out: Member = { id: m.id, name: m.name };
    // Only write `active` when it is false, so a round trip reproduces the
    // original object exactly rather than adding `active: true` everywhere.
    if (!m.active) out.active = false;
    return out;
  });

  // Splits and payments are sets keyed by (expense_id, member_id) with no
  // position column of their own, so PostgREST's embedded order for them is
  // arbitrary. The app always builds them in member order, so restoring that
  // order means sorting by the position of the member each row references —
  // not by the member_id string, which is a random UUID and carries no order.
  const memberPosition = new Map<string, number>(row.members.map((m: MemberPayload) => [m.id, m.position]));
  const byMemberPosition = (a: AmountRow, b: AmountRow): number =>
    (memberPosition.get(a.member_id) ?? 0) - (memberPosition.get(b.member_id) ?? 0);

  const expenses: Expense[] = [...row.expenses].sort(byPosition).map((e) => {
    const out: Expense = {
      id: e.id,
      title: e.title,
      payerId: e.payer_id,
      total: num(e.total),
      splits: [...e.splits].sort(byMemberPosition).map((s: AmountRow) => ({ memberId: s.member_id, amount: num(s.amount) })),
      category: e.category,
      date: e.spent_at,
    };
    if (e.payments && e.payments.length > 0) {
      out.payers = [...e.payments].sort(byMemberPosition).map((p: AmountRow) => ({ memberId: p.member_id, amount: num(p.amount) }));
    }
    return out;
  });

  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    members,
    expenses,
  };
}

export function remoteToTrips(rows: RemoteTrip[]): Trip[] {
  return rows.map(remoteToTrip);
}
