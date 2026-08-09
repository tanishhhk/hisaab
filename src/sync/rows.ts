import { Trip, Member, Expense, Split } from '../App';

// The wire shapes. snake_case because these cross into Postgres unchanged;
// the camelCase types in App.tsx stay the app's own vocabulary.

// A row in a splits or payments set. Keyed by (expense_id, member_id) with a
// unique constraint at the table level and no identity or order of its own —
// PostgREST makes no promise about the order it returns an embedded resource
// in. tripToPayload and remoteToTrip both canonicalise AmountRow arrays to the
// order their members appear in trip.members, so array order is never
// preserved end to end, only the (member, amount) set is.
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
  // Members and expenses now merge independently, so each arrives with its
  // own stamp rather than borrowing the trip's.
  members: (MemberPayload & { updated_at: string })[];
  expenses: (Omit<ExpensePayload, 'payments'> & {
    payments: AmountRow[];
    updated_at: string;
  })[];
}

// numeric(12,2) can arrive as a JSON number or a string depending on the
// PostgREST version and column size. Coercing once here keeps every consumer
// from having to care.
const num = (v: number | string): number => Number(v);

const byPosition = <T extends { position: number }>(a: T, b: T): number => a.position - b.position;

// Order splits and payments by where their member sits in the roster. Not by
// member_id, which is a random uuid carrying no order at all.
function memberOrder(members: Member[]) {
  const pos = new Map<string, number>(members.map((m: Member, i: number) => [m.id, i]));
  return (a: { memberId: string }, b: { memberId: string }): number =>
    (pos.get(a.memberId) ?? 0) - (pos.get(b.memberId) ?? 0);
}

export function memberPayload(m: Member, index: number): MemberPayload {
  return {
    id: m.id,
    name: m.name,
    // Absent means active, per isActive(). The column is NOT NULL, so the
    // default has to be resolved here rather than in SQL.
    active: m.active !== false,
    position: index,
  };
}

export function expensePayload(e: Expense, index: number, members: Member[]): ExpensePayload {
  const order = memberOrder(members);
  return {
    id: e.id,
    title: e.title,
    payer_id: e.payerId,
    total: Number(e.total),
    category: e.category,
    spent_at: e.date,
    position: index,
    splits: [...e.splits].sort(order).map((s: Split) => ({ member_id: s.memberId, amount: Number(s.amount) })),
    payments: e.payers
      ? [...e.payers].sort(order).map((p: Split) => ({ member_id: p.memberId, amount: Number(p.amount) }))
      : null,
  };
}

export function tripToPayload(trip: Trip): TripPayload {
  // Composed from the per-entity builders so a whole-trip payload and a
  // single-entity push can never drift apart in shape.
  return {
    id: trip.id,
    name: trip.name,
    created_at: trip.createdAt ?? new Date().toISOString(),
    members: trip.members.map(memberPayload),
    expenses: trip.expenses.map((e: Expense, i: number) => expensePayload(e, i, trip.members)),
  };
}

export function remoteToTrip(row: RemoteTrip): Trip {
  const members: Member[] = [...row.members].sort(byPosition).map((m) => {
    const out: Member = { id: m.id, name: m.name, updatedAt: m.updated_at };
    // Only write `active` when it is false, so a round trip reproduces the
    // original object exactly rather than adding `active: true` everywhere.
    if (!m.active) out.active = false;
    return out;
  });

  // See the AmountRow comment: canonicalise, don't preserve. Sort by the
  // position of the member each row references — not by the member_id
  // string, which is a random UUID and carries no order of its own.
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
      updatedAt: e.updated_at,
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
