import React, { useEffect, useState } from 'react';

// TypeScript Interfaces
export interface Member {
  id: string;
  name: string;
  // Members are soft-deleted so their past payments and debts stay in the
  // ledger after removal. Absent means active, so trips saved before this
  // field existed keep working without migration.
  active?: boolean;
}

export interface Split {
  memberId: string;
  amount: number;
}

export interface Expense {
  id: string;
  title: string;
  payerId: string;
  total: number;
  splits: Split[];
  category: string;
  date: string;
}

export interface Trip {
  id: string;
  name: string;
  members: Member[];
  expenses: Expense[];
}

interface NewTripModalProps {
  onClose: () => void;
  onCreate: (trip: Trip) => void;
}

interface TripCardProps {
  trip: Trip;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

interface MemberListProps {
  members: Member[];
  addMember: (member: Member) => void;
  onRequestRemove: (member: Member) => void;
}

export type RemovalMode = 'redistribute' | 'keep';

interface RemoveMemberModalProps {
  member: Member;
  trip: Trip;
  onClose: () => void;
  onConfirm: (mode: RemovalMode) => void;
}

interface ExpenseFormProps {
  members: Member[];
  onAdd: (expense: Expense) => void;
}

interface ExpenseListProps {
  expenses: Expense[];
  members: Member[];
  onDelete: (id: string) => void;
}

interface SummaryPanelProps {
  trip: Trip;
}

// TripExpenseApp.tsx
// Single-file React component (Tailwind CSS expected in parent project)
// Default export at bottom

// Data model (saved to localStorage):
// trips: [{ id, name, members: [{id,name}], expenses: [{id, title, payerId, total, splits: [{memberId, amount}], category, date}] }]

function uid(prefix: string = ''): string {
  return prefix + Math.random().toString(36).slice(2, 9);
}

// Display formatting only. Groups digits the Indian way (₹1,69,500.00), which
// is what these amounts are read in. Never parse this back into a number —
// the separators make Number() return NaN.
function currency(n: number): string {
  return (Math.round(n * 100) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Split `total` across `memberIds` so the parts always add back up to `total`.
// Works in paise (integer minor units) and hands the leftover paise out one
// each, so N shares of a non-divisible total never lose or invent money.
export function allocateEqually(total: number, memberIds: string[]): Split[] {
  if (memberIds.length === 0) return [];
  const totalPaise = Math.round(total * 100);
  const base = Math.floor(totalPaise / memberIds.length);
  const remainder = totalPaise - base * memberIds.length;
  return memberIds.map((memberId: string, i: number) => ({
    memberId,
    amount: (base + (i < remainder ? 1 : 0)) / 100,
  }));
}

// Quote a CSV cell: wrap when it holds a delimiter/quote/newline, double any
// embedded quotes, and neutralise leading =+-@ so spreadsheets treat member
// names and titles as text rather than formulas.
export function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A member is active unless explicitly retired. Trips saved before soft-delete
// existed have no `active` field, so `undefined` has to read as active.
export function isActive(m: Member): boolean {
  return m.active !== false;
}

// An expense counts as "equally distributed" when its shares are all within a
// paisa of each other, which is exactly what allocateEqually produces. This is
// derived rather than stored so trips saved before this change classify too.
export function isEqualSplit(e: Expense): boolean {
  if (e.splits.length <= 1) return true;
  const paise = e.splits.map((s: Split) => Math.round(s.amount * 100));
  return Math.max(...paise) - Math.min(...paise) <= 1;
}

// Everyone the ledger has to account for: the current roster, plus removed
// members who still have money attached. Leaving the latter out would drop a
// removed payer's contribution while everyone's debt for it stayed behind.
export function ledgerMembers(trip: Trip): Member[] {
  return trip.members.filter((m: Member) =>
    isActive(m) ||
    trip.expenses.some((e: Expense) =>
      e.payerId === m.id || e.splits.some((s: Split) => s.memberId === m.id)
    )
  );
}

// What removing this member would touch, so the dialog can state it plainly
// instead of making the user guess.
export function removalImpact(trip: Trip, memberId: string) {
  const involved = trip.expenses.filter((e: Expense) =>
    e.splits.some((s: Split) => s.memberId === memberId)
  );
  const redistributable = involved.filter(
    (e: Expense) => isEqualSplit(e) && e.splits.length > 1
  );
  return {
    paidCount: trip.expenses.filter((e: Expense) => e.payerId === memberId).length,
    involvedCount: involved.length,
    redistributableCount: redistributable.length,
    customCount: involved.filter((e: Expense) => !isEqualSplit(e)).length,
    soleCount: involved.filter((e: Expense) => e.splits.length === 1).length,
  };
}

// Retire a member. Both modes keep the member record (and so their name and
// their payment history); they differ only in what happens to the expenses the
// member was a participant in.
//
//   'redistribute' - drop them from equally-split expenses and re-divide the
//                    full total across whoever is left. Custom splits are left
//                    alone: there is no way to guess how a hand-entered amount
//                    should be reassigned.
//   'keep'         - leave every existing expense exactly as recorded; the
//                    member simply stops being offered on new ones.
export function applyRemoval(trip: Trip, memberId: string, mode: RemovalMode): Trip {
  const members = trip.members.map((m: Member) =>
    m.id === memberId ? { ...m, active: false } : m
  );
  if (mode === 'keep') return { ...trip, members };

  const expenses = trip.expenses.map((e: Expense) => {
    if (!e.splits.some((s: Split) => s.memberId === memberId)) return e;
    if (!isEqualSplit(e)) return e;
    const remaining = e.splits
      .filter((s: Split) => s.memberId !== memberId)
      .map((s: Split) => s.memberId);
    // Nobody left to absorb the share, so the expense stays as recorded.
    if (remaining.length === 0) return e;
    return { ...e, splits: allocateEqually(e.total, remaining) };
  });
  return { ...trip, members, expenses };
}

// A realistic trip so a first-time visitor can see the settlement maths work
// on real numbers instead of staring at an empty screen. Built through
// allocateEqually so the sample obeys the same rules as anything they enter.
export function sampleTrip(): Trip {
  const m = (name: string): Member => ({ id: uid('m_'), name });
  const [asha, bilal, chetan, divya] = [m('Asha'), m('Bilal'), m('Chetan'), m('Divya')];
  const members = [asha, bilal, chetan, divya];
  const all = members.map((x: Member) => x.id);
  const day = (offset: number) =>
    new Date(Date.now() - offset * 86400000).toISOString();

  const expense = (
    title: string, payer: Member, total: number,
    splits: Split[], category: string, offset: number
  ): Expense => ({ id: uid('e_'), title, payerId: payer.id, total, splits, category, date: day(offset) });

  return {
    id: uid('t_'),
    name: 'Indore Weekend (sample)',
    members,
    expenses: [
      expense('Hotel, two nights', bilal, 8600, allocateEqually(8600, all), 'hotel', 5),
      expense('Sarafa street food', asha, 2400, allocateEqually(2400, all), 'food', 5),
      expense('Cab to Mandu', chetan, 3500, allocateEqually(3500, [asha.id, bilal.id, chetan.id]), 'car', 4),
      expense('Petrol', asha, 1000, [{ memberId: asha.id, amount: 600 }, { memberId: divya.id, amount: 400 }], 'petrol', 4),
      expense('56 Dukan breakfast', divya, 1450, allocateEqually(1450, all), 'food', 3),
    ],
  };
}

function EmptyState({ onCreate, onSample }: { onCreate: () => void; onSample: () => void }) {
  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
      <div className="grid gap-8 p-8 sm:p-12 lg:grid-cols-2 lg:items-center">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Split trip costs.<br />Settle up in the fewest payments.
          </h2>
          <p className="mt-4 max-w-md text-slate-600">
            Add everyone who came, log what each person paid, and get the shortest
            list of transfers that squares the whole group up.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <button
              className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-5 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-brand-700"
              onClick={onCreate}
            >
              Create your first trip
            </button>
            <button
              className="inline-flex items-center justify-center rounded-lg px-5 py-2.5 font-medium text-slate-700 ring-1 ring-slate-300 transition-colors hover:bg-slate-50"
              onClick={onSample}
            >
              Try a sample trip
            </button>
          </div>
        </div>

        {/* A still of the actual output, not decoration. aria-hidden because
            it repeats what the copy already says. */}
        <div aria-hidden className="rounded-xl bg-slate-50 p-5 ring-1 ring-slate-200">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Who pays whom
          </div>
          <div className="mt-3 space-y-2">
            {[
              { from: 'Asha', to: 'Bilal', amt: '1,479.17' },
              { from: 'Chetan', to: 'Bilal', amt: '779.16' },
              { from: 'Divya', to: 'Bilal', amt: '2,062.50' },
            ].map((r) => (
              <div
                key={r.from}
                className="flex items-center justify-between rounded-lg bg-white px-3 py-2.5 text-sm ring-1 ring-slate-200"
              >
                <span className="flex items-center gap-2 text-slate-700">
                  {r.from}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-slate-400">
                    <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {r.to}
                </span>
                <span className="font-semibold tnum text-slate-900">₹{r.amt}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-xs text-slate-500">
            Four people, five expenses, three transfers.
          </div>
        </div>
      </div>
    </section>
  );
}

function useLocalState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch (e) {
      return initial;
    }
  });
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);
  return [state, setState];
}

function NewTripModal({ onClose, onCreate }: NewTripModalProps) {
  const [name, setName] = useState<string>('');
  const create = () => {
    if (!name.trim()) return alert('Enter trip name');
    onCreate({ id: uid('t_'), name: name.trim(), members: [], expenses: [] });
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-lift animate-rise">
        <h3 className="text-lg font-semibold mb-3">Create new trip</h3>
        <input 
          className="w-full rounded-lg border-slate-300 bg-white p-2.5 text-sm ring-1 ring-inset ring-slate-300 transition focus:ring-2 focus:ring-brand-600 mb-4" 
          value={name} 
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} 
          placeholder="Trip name" 
        />
        <div className="flex gap-2 justify-end">
          <button className="inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition-colors hover:bg-slate-50" onClick={onClose}>Cancel</button>
          <button className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700" onClick={create}>Create</button>
        </div>
      </div>
    </div>
  );
}

function RemoveMemberModal({ member, trip, onClose, onConfirm }: RemoveMemberModalProps) {
  const impact = removalImpact(trip, member.id);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-lift animate-rise">
        <h3 className="text-lg font-semibold mb-1">Remove {member.name}?</h3>
        <div className="text-sm text-slate-600 mb-4">
          {impact.involvedCount === 0
            ? 'They are not part of any expense yet.'
            : `They are a participant in ${impact.involvedCount} expense${impact.involvedCount === 1 ? '' : 's'}.`}
          {impact.paidCount > 0 &&
            ` They also paid for ${impact.paidCount} expense${impact.paidCount === 1 ? '' : 's'} — those payments stay in the summary either way.`}
        </div>

        <div className="space-y-3">
          <button
            className="w-full rounded-xl p-4 text-left ring-1 ring-slate-200 transition-colors hover:bg-brand-50 hover:ring-brand-200"
            onClick={() => onConfirm('redistribute')}
          >
            <div className="font-medium">Remove and split their share</div>
            <div className="text-sm text-slate-600 mt-1">
              {impact.redistributableCount > 0
                ? `Their share of ${impact.redistributableCount} equally-split expense${impact.redistributableCount === 1 ? '' : 's'} is divided across the remaining participants.`
                : 'No equally-split expenses to redistribute.'}
              {impact.customCount > 0 &&
                ` ${impact.customCount} custom-split expense${impact.customCount === 1 ? ' is' : 's are'} left untouched.`}
              {impact.soleCount > 0 &&
                ` ${impact.soleCount} expense${impact.soleCount === 1 ? ' where they were' : 's where they were'} the only participant stay${impact.soleCount === 1 ? 's' : ''} as recorded.`}
            </div>
          </button>

          <button
            className="w-full rounded-xl p-4 text-left ring-1 ring-slate-200 transition-colors hover:bg-brand-50 hover:ring-brand-200"
            onClick={() => onConfirm('keep')}
          >
            <div className="font-medium">Remove from future expenses only</div>
            <div className="text-sm text-slate-600 mt-1">
              Every existing expense stays exactly as recorded. {member.name} just stops
              being offered when you add new ones.
            </div>
          </button>
        </div>

        <div className="flex justify-end mt-4">
          <button className="inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition-colors hover:bg-slate-50" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function TripCard({ trip, onOpen, onDelete }: TripCardProps) {
  const total = trip.expenses.reduce((s: number, e: Expense) => s + Number(e.total), 0);
  return (
    <div className="rounded-xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 transition-shadow hover:shadow-lift">
      <div className="flex justify-between items-start">
        <div>
          <h4 className="font-semibold text-lg">{trip.name}</h4>
          <div className="text-sm text-slate-600">Members: {trip.members.filter(isActive).length} • Expenses: {trip.expenses.length}</div>
        </div>
        <div className="text-right">
          <div className="text-sm text-slate-600">Total</div>
          <div className="font-bold tnum">₹{currency(total)}</div>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button className="flex-1 inline-flex items-center justify-center rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700" onClick={() => onOpen(trip.id)}>Open</button>
        <button className="inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition-colors hover:bg-slate-50" onClick={() => onDelete(trip.id)}>Delete</button>
      </div>
    </div>
  );
}

function MemberList({ members, addMember, onRequestRemove }: MemberListProps) {
  const [name, setName] = useState<string>('');
  return (
    <div className="rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
      <h5 className="font-medium mb-2">Members</h5>
      <div className="flex gap-2 mb-3">
        <input 
          value={name} 
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} 
          placeholder="Member name" 
          className="flex-1 rounded-lg bg-white p-2.5 text-sm ring-1 ring-inset ring-slate-300 transition focus:ring-2 focus:ring-brand-600" 
        />
        <button 
          className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700"
          onClick={() => { 
            if (!name.trim()) return; 
            addMember({ id: uid('m_'), name: name.trim() }); 
            setName(''); 
          }}
        >
          Add
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {members.map((m: Member) => (
          <div key={m.id} className="flex items-center gap-2 rounded-full bg-slate-100 py-1 pl-3 pr-2 text-sm ring-1 ring-slate-200">
            <div className="text-sm">{m.name}</div>
            <button className="text-xs text-red-600" onClick={() => onRequestRemove(m)}>remove</button>
          </div>
        ))}
        {members.length === 0 && <div className="text-sm text-slate-500">No members yet</div>}
      </div>
    </div>
  );
}

function ExpenseForm({ members, onAdd }: ExpenseFormProps) {
  const categories = ['bus','auto','petrol', 'car', 'hotel', 'food','other'];
  const [title, setTitle] = useState<string>('');
  const [payerId, setPayerId] = useState<string>(members[0]?.id || '');
  const [total, setTotal] = useState<string>('');
  const [category, setCategory] = useState<string>('food');
  const [method, setMethod] = useState<'equal' | 'unequal'>('equal');
  const [selected, setSelected] = useState<string[]>(() => members.map((m: Member) => m.id));
  const [customSplits, setCustomSplits] = useState<Record<string, string>>({});

  // Key on the member IDs, not the array identity: the parent rebuilds
  // `members` on every render, so depending on [members] re-ran this (and wiped
  // the in-progress form) continuously. Reconcile instead of resetting, so
  // adding a member mid-entry no longer discards the current selection.
  const memberKey = members.map((m: Member) => m.id).join(',');
  useEffect(() => {
    const ids = members.map((m: Member) => m.id);
    setPayerId((prev: string) => (ids.includes(prev) ? prev : ids[0] || ''));
    setSelected((prev: string[]) => {
      const kept = prev.filter((id: string) => ids.includes(id));
      return kept.length ? kept : ids;
    });
    setCustomSplits((prev: Record<string, string>) => {
      const next: Record<string, string> = {};
      ids.forEach((id: string) => { if (prev[id] !== undefined) next[id] = prev[id]; });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberKey]);

  if (members.length === 0) {
    return (
      <div className="rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
        <h5 className="font-medium mb-2">Add expense</h5>
        <div className="text-sm text-slate-500">Add at least one member before recording an expense.</div>
      </div>
    );
  }

  const toggleSelected = (id: string) => {
    setSelected((prev: string[]) => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const submit = () => {
    if (!title.trim()) return alert('Title required');
    const t = Number(total);
    if (!t || t <= 0) return alert('Enter valid total');
    let splits: Split[] = [];
    if (method === 'equal') {
      // Only split across members who still exist; an empty selection is a
      // mistake, not a reason to record an expense nobody owes.
      const targets = selected.filter((id: string) => members.some((m: Member) => m.id === id));
      if (targets.length === 0) return alert('Select at least one participant');
      splits = allocateEqually(t, targets);
    } else {
      // unequal: customSplits must add up to total. Drive off the current
      // member list so amounts typed for since-removed members can't leak in.
      const entries: Split[] = members
        .map((m: Member) => ({ memberId: m.id, amount: Number(customSplits[m.id] || 0) }))
        .filter((e: Split) => Number.isFinite(e.amount) && e.amount > 0);
      const sum = entries.reduce((s: number, e: Split) => s + e.amount, 0);
      if (Math.abs(sum - t) > 0.01) return alert(`Custom splits must add up to total (current ${currency(sum)})`);
      if (entries.length === 0) return alert('Enter at least one split amount');
      splits = entries;
    }

    onAdd({ 
      id: uid('e_'), 
      title: title.trim(), 
      payerId, 
      total: Number(t), 
      splits, 
      category, 
      date: new Date().toISOString() 
    });
    // reset
    setTitle('');
    setTotal('');
    setSelected(members.map((m: Member) => m.id));
    setCustomSplits({});
    setMethod('equal');
  };

  return (
    <div className="rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
      <h5 className="font-medium mb-2">Add expense</h5>
      <input 
        value={title} 
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)} 
        placeholder="Expense title" 
        className="w-full rounded-lg bg-white p-2.5 text-sm ring-1 ring-inset ring-slate-300 transition focus:ring-2 focus:ring-brand-600 mb-2" 
      />
      <div className="flex gap-2 mb-2">
        <select 
          value={payerId} 
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPayerId(e.target.value)} 
          className="flex-1 rounded-lg bg-white p-2.5 text-sm ring-1 ring-inset ring-slate-300 transition focus:ring-2 focus:ring-brand-600"
        >
          {members.map((m: Member) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <input 
          value={total} 
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTotal(e.target.value)} 
          placeholder="Total" 
          className="w-28 rounded-lg bg-white p-2.5 text-sm ring-1 ring-inset ring-slate-300 transition focus:ring-2 focus:ring-brand-600" 
        />
        <select 
          value={category} 
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCategory(e.target.value)} 
          className="w-36 rounded-lg bg-white p-2.5 text-sm ring-1 ring-inset ring-slate-300 transition focus:ring-2 focus:ring-brand-600"
        >
          {categories.map((c: string) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="mb-2">
        <div className="text-sm mb-1">Split method</div>
        <div className="flex gap-2">
          <label className={`px-3 py-1 border rounded ${method==='equal' ? 'bg-slate-100' : ''}`}>
            <input 
              type="radio" 
              name="method" 
              checked={method==='equal'} 
              onChange={() => setMethod('equal')} 
            /> Equal
          </label>
          <label className={`px-3 py-1 border rounded ${method==='unequal' ? 'bg-slate-100' : ''}`}>
            <input 
              type="radio" 
              name="method" 
              checked={method==='unequal'} 
              onChange={() => setMethod('unequal')} 
            /> Custom
          </label>
        </div>
      </div>

      <div className="mb-2">
        <div className="text-sm mb-1">Participants</div>
        <div className="flex flex-wrap gap-2">
          {members.map((m: Member) => (
            <label key={m.id} className={`px-2 py-1 border rounded ${selected.includes(m.id) ? 'bg-slate-100' : ''}`}>
              <input 
                type="checkbox" 
                checked={selected.includes(m.id)} 
                onChange={() => toggleSelected(m.id)} 
              /> {m.name}
            </label>
          ))}
        </div>
      </div>

      {method === 'unequal' && (
        <div className="mb-2">
          <div className="text-sm mb-1">Custom split amounts (must sum to total)</div>
          <div className="flex flex-col gap-2">
            {members.map((m: Member) => (
              <div key={m.id} className="flex gap-2 items-center">
                <div className="w-28 text-sm">{m.name}</div>
                <input 
                  className="flex-1 rounded-lg bg-white p-2.5 text-sm ring-1 ring-inset ring-slate-300 transition focus:ring-2 focus:ring-brand-600" 
                  value={customSplits[m.id] ?? ''} 
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomSplits(prev => ({ ...prev, [m.id]: e.target.value }))} 
                  placeholder="0" 
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button 
          className="inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition-colors hover:bg-slate-50" 
          onClick={() => { setTitle(''); setTotal(''); setMethod('equal'); setCustomSplits({}); }}
        >
          Reset
        </button>
        <button className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700" onClick={submit}>Add expense</button>
      </div>
    </div>
  );
}

function ExpenseList({ expenses, members, onDelete }: ExpenseListProps) {
  const nameOf = (id: string): string => members.find((m: Member) => m.id === id)?.name || 'Unknown';
  return (
    <div className="rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
      <h5 className="font-medium mb-2">Expenses</h5>
      {expenses.length === 0 && <div className="text-sm text-slate-500">No expenses yet</div>}
      <div className="space-y-2">
        {expenses.map((e: Expense) => (
          <div key={e.id} className="flex items-start justify-between gap-3 rounded-lg p-3 ring-1 ring-slate-200 transition-colors hover:bg-slate-50">
            <div>
              <div className="font-medium">{e.title} <span className="text-xs text-slate-500">({e.category})</span></div>
              <div className="text-sm text-slate-600 tnum">Paid by {nameOf(e.payerId)} • ₹{currency(e.total)}</div>
              <div className="text-sm mt-1">Split:</div>
              <div className="flex gap-2 flex-wrap mt-1">
                {e.splits.map((s: Split) => (
                  <div key={s.memberId} className="rounded-md bg-slate-100 px-2 py-1 text-sm tnum ring-1 ring-slate-200/80">
                    {members.find((m: Member) => m.id===s.memberId)?.name || s.memberId}: ₹{currency(s.amount)}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2 items-end">
              <div className="font-semibold tnum">₹{currency(e.total)}</div>
              <button className="text-xs text-red-600" onClick={() => onDelete(e.id)}>remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryPanel({ trip }: SummaryPanelProps) {
  const members = ledgerMembers(trip);
  const totalsByMemberPaid: Record<string, number> = {};
  const totalsByMemberOwed: Record<string, number> = {};
  const categoryTotals: Record<string, number> = {};

  members.forEach((m: Member) => { 
    totalsByMemberPaid[m.id] = 0; 
    totalsByMemberOwed[m.id] = 0; 
  });

  trip.expenses.forEach((e: Expense) => {
    totalsByMemberPaid[e.payerId] = (totalsByMemberPaid[e.payerId] || 0) + Number(e.total);
    categoryTotals[e.category] = (categoryTotals[e.category] || 0) + Number(e.total);
    e.splits.forEach((s: Split) => {
      totalsByMemberOwed[s.memberId] = (totalsByMemberOwed[s.memberId] || 0) + Number(s.amount);
    });
  });

  // net = paid - owed (positive means others owe them; negative means they owe others)
  const net = members.map((m: Member) => ({
    id: m.id,
    name: m.name,
    removed: !isActive(m),
    paid: totalsByMemberPaid[m.id] || 0,
    owed: totalsByMemberOwed[m.id] || 0,
    net: (totalsByMemberPaid[m.id] || 0) - (totalsByMemberOwed[m.id] || 0)
  }));

  // Simplified settlement suggestion: who owes who — greedy algorithm
  function settlements() {
    const list = net.map(x => ({ ...x }));
    const debtors = list.filter(x => x.net < -0.005).map(x => ({ ...x, need: -x.net }));
    const creditors = list.filter(x => x.net > 0.005).map(x => ({ ...x, can: x.net }));
    const ops: { from: string; to: string; amount: number }[] = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const d = debtors[i];
      const c = creditors[j];
      const amt = Math.min(d.need, c.can);
      // Round numerically rather than parsing currency()'s formatted output —
      // that string carries digit grouping and would parse back as NaN.
      ops.push({ from: d.name, to: c.name, amount: Math.round(amt * 100) / 100 });
      d.need -= amt; c.can -= amt;
      if (d.need <= 0.005) i++;
      if (c.can <= 0.005) j++;
    }
    return ops;
  }

  const settle = settlements();
  const totalTrip = trip.expenses.reduce((s: number, e: Expense) => s + Number(e.total), 0);
  const activeCount = trip.members.filter(isActive).length;
  const perHead = activeCount ? totalTrip / activeCount : 0;

  return (
    <div className="rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
      <h5 className="font-medium mb-2">Summary</h5>
      <div className="mb-3">
        <div className="text-sm text-slate-600">Trip total</div>
        <div className="text-3xl font-semibold tracking-tight tnum">₹{currency(totalTrip)}</div>
        <div className="mt-1 text-sm text-slate-600 tnum">Per head (if shared equally): ₹{currency(perHead)}</div>
      </div>

      <div className="mb-3">
        <div className="text-sm font-medium mb-2">Paid vs Owed</div>
        <div className="grid grid-cols-1 gap-2">
          {net.map(n => (
            <div key={n.id} className="flex items-center justify-between gap-3 rounded-lg p-3 ring-1 ring-slate-200">
              <div className="min-w-0">
                <div className="font-medium truncate">
                  {n.name}
                  {n.removed && <span className="ml-2 text-xs font-normal text-slate-500">(removed)</span>}
                </div>
                <div className="text-sm text-slate-600 tnum">Paid ₹{currency(n.paid)} • Owes ₹{currency(n.owed)}</div>
              </div>
              {/* Direction is carried by the word, not only by colour, so the
                  row still reads correctly without colour vision. */}
              <div className={`shrink-0 whitespace-nowrap text-right text-sm font-semibold tnum ${n.net>=0 ? 'text-credit-700' : 'text-debit-700'}`}>
                <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  {n.net >= 0 ? 'Receives' : 'Pays'}
                </span>
                ₹{currency(Math.abs(n.net))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-3">
        <div className="text-sm font-medium mb-2">Settlement suggestions</div>
        {settle.length === 0 && <div className="text-sm text-slate-500">All settled</div>}
        <div className="space-y-2">
          {settle.map((s, idx: number) => (
            <div key={idx} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
              <div className="text-sm">{s.from} → {s.to}</div>
              <div className="font-semibold tnum">₹{currency(s.amount)}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="text-sm font-medium mb-2">Category breakdown</div>
        <div className="flex gap-2 flex-wrap">
          {Object.entries(categoryTotals).map(([cat, amt]: [string, number]) => (
            <div key={cat} className="rounded-lg bg-slate-50 px-3 py-2 text-sm tnum ring-1 ring-slate-200">{cat}: ₹{currency(amt)}</div>
          ))}
          {Object.keys(categoryTotals).length === 0 && <div className="text-sm text-slate-500">No expenses yet</div>}
        </div>
      </div>
    </div>
  );
}

export default function TripExpenseApp() {
  const [trips, setTrips] = useLocalState<Trip[]>('trips_v1', []);
  const [showNew, setShowNew] = useState<boolean>(false);
  const [openTripId, setOpenTripId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Member | null>(null);

  const createTrip = (t: Trip) => setTrips((prev: Trip[]) => [t, ...prev]);
  const deleteTrip = (id: string) => setTrips((prev: Trip[]) => prev.filter((t: Trip) => t.id !== id));

  const openTrip = (id: string) => setOpenTripId(id);
  const closeTrip = () => setOpenTripId(null);

  const updateTrip = (updated: Trip) => setTrips((prev: Trip[]) => prev.map((t: Trip) => t.id === updated.id ? updated : t));

  const current = trips.find((t: Trip) => t.id === openTripId);
  const activeMembers = current ? current.members.filter(isActive) : [];

  const confirmRemoval = (mode: RemovalMode) => {
    if (current && pendingRemoval) updateTrip(applyRemoval(current, pendingRemoval.id, mode));
    setPendingRemoval(null);
  };

  // Seed a worked example and open it straight away — the point is to show the
  // settlement output, not to leave another empty trip on the list.
  const loadSample = () => {
    const t = sampleTrip();
    setTrips((prev: Trip[]) => [t, ...prev]);
    setOpenTripId(t.id);
  };

  // Wiping every trip is unrecoverable, so name what is about to be lost.
  const resetAllData = () => {
    const n = trips.length;
    const expenseCount = trips.reduce((s: number, t: Trip) => s + t.expenses.length, 0);
    const ok = window.confirm(
      `Delete all ${n} trip${n === 1 ? '' : 's'} and ${expenseCount} expense${expenseCount === 1 ? '' : 's'}?\n\n` +
      'This cannot be undone. Export to CSV first if you want a copy.'
    );
    if (ok) setTrips([]);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6 font-sans">
      <div className="max-w-6xl mx-auto">
        <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold">Trip Expense Manager</h1>
            <p className="text-sm text-slate-500 mt-1">
              Saved in this browser only — it won't follow you to another device.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Destructive and irreversible, so it stays out of reach of the
                primary action and only appears when there is data to lose. */}
            {!current && trips.length > 0 && (
              <button
                className="rounded-lg px-3 py-2 text-sm font-medium text-debit-700/70 transition-colors hover:bg-debit-50 hover:text-debit-700"
                onClick={resetAllData}
              >
                Reset data
              </button>
            )}
            <button
              className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700"
              onClick={() => setShowNew(true)}
            >
              New trip
            </button>
          </div>
        </header>

        {!current && trips.length === 0 && (
          <main>
            <EmptyState onCreate={() => setShowNew(true)} onSample={loadSample} />
          </main>
        )}

        {!current && trips.length > 0 && (
          <main className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-4 md:col-span-2">
              <div className="rounded-xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
                <h3 className="font-semibold mb-3">Your trips</h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {trips.map((t: Trip) => (
                    <TripCard key={t.id} trip={t} onOpen={openTrip} onDelete={deleteTrip} />
                  ))}
                </div>
              </div>
            </div>

            <aside>
              <div className="rounded-xl bg-white p-5 shadow-card ring-1 ring-slate-200/70">
                <h3 className="font-semibold mb-3">Quick stats</h3>
                <div className="text-sm text-slate-700">Trips: {trips.length}</div>
                <div className="text-sm text-slate-700 tnum">
                  Total expenses (all trips): ₹{currency(trips.reduce((s: number, t: Trip) => s + t.expenses.reduce((ss: number, e: Expense) => ss + Number(e.total), 0), 0))}
                </div>
              </div>
            </aside>
          </main>
        )}

        {current && (
          <main className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">{current.name}</h2>
                <div className="text-sm text-slate-600">Members: {activeMembers.length} • Expenses: {current.expenses.length}</div>
              </div>
              <div className="flex gap-2">
                <button className="inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition-colors hover:bg-slate-50" onClick={closeTrip}>Back</button>
                <button 
                  className="inline-flex items-center justify-center rounded-lg bg-debit-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-debit-700" 
                  onClick={() => { 
                    if (window.confirm('Delete this trip?')) { 
                      deleteTrip(current.id); 
                      closeTrip(); 
                    } 
                  }}
                >
                  Delete trip
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-2">
                <MemberList
                  members={activeMembers}
                  addMember={(m: Member) => {
                    const upd = { ...current, members: [...current.members, m] };
                    updateTrip(upd);
                  }}
                  onRequestRemove={(m: Member) => setPendingRemoval(m)}
                />

                <ExpenseForm 
                  members={activeMembers}
                  onAdd={(exp: Expense) => {
                    const upd = { ...current, expenses: [...current.expenses, exp] }; 
                    updateTrip(upd); 
                  }} 
                />

                <ExpenseList 
                  expenses={current.expenses} 
                  members={current.members} 
                  onDelete={(id: string) => { 
                    const upd = { ...current, expenses: current.expenses.filter((e: Expense) => e.id !== id) }; 
                    updateTrip(upd); 
                  }} 
                />
              </div>

              {/* On a phone the answer comes first: without this you scroll
                  past every expense to reach who-owes-whom. On desktop it
                  returns to the right-hand column. */}
              <div className="order-first space-y-4 lg:order-none">
                <SummaryPanel trip={current} />
                <div className="rounded-xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
                  <h5 className="font-medium mb-2">Actions</h5>
<div className="space-y-2">
  <button 
    className="w-full inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition-colors hover:bg-slate-50" 
    onClick={() => { 
      // Export to CSV
      const nameOf = (id: string): string => current.members.find((m: Member) => m.id === id)?.name || 'Unknown';
      
      // Create CSV data for expenses
      const csvRows = [
        ['Date', 'Title', 'Category', 'Paid By', 'Total Amount', 'Participant', 'Split Amount'].map(csvCell).join(',')
      ];

      current.expenses.forEach((exp: Expense) => {
        exp.splits.forEach((split: Split) => {
          csvRows.push([
            new Date(exp.date).toLocaleDateString(),
            exp.title,
            exp.category,
            nameOf(exp.payerId),
            exp.total.toString(),
            nameOf(split.memberId),
            split.amount.toString()
          ].map(csvCell).join(','));
        });
      });
      
      const csvContent = csvRows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${current.name.replace(/\s+/g,'_')}_expenses.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }}
  >
    Export CSV
  </button>
  <button 
    className="w-full inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition-colors hover:bg-slate-50" 
    onClick={async () => {
      // SheetJS is bundled, not fetched from a CDN, so export works offline.
      // The import is dynamic so the ~400 KB library is code-split into its own
      // chunk and only downloaded when someone actually exports.
      let XLSX;
      try {
        XLSX = await import('xlsx');
      } catch (err) {
        alert('Could not load the spreadsheet library.');
        return;
      }

      const nameOf = (id: string): string => current.members.find((m: Member) => m.id === id)?.name || 'Unknown';
      
      // Create expenses sheet data
      const expensesData = current.expenses.flatMap((exp: Expense) => 
        exp.splits.map((split: Split) => ({
          'Date': new Date(exp.date).toLocaleDateString(),
          'Title': exp.title,
          'Category': exp.category,
          'Paid By': nameOf(exp.payerId),
          'Total Amount': exp.total,
          'Participant': nameOf(split.memberId),
          'Split Amount': split.amount
        }))
      );
      
      // Create summary sheet data
      const totalsByMemberPaid: Record<string, number> = {};
      const totalsByMemberOwed: Record<string, number> = {};
      
      const sheetMembers = ledgerMembers(current);
      sheetMembers.forEach((m: Member) => {
        totalsByMemberPaid[m.id] = 0;
        totalsByMemberOwed[m.id] = 0;
      });
      
      current.expenses.forEach((e: Expense) => {
        totalsByMemberPaid[e.payerId] = (totalsByMemberPaid[e.payerId] || 0) + Number(e.total);
        e.splits.forEach((s: Split) => {
          totalsByMemberOwed[s.memberId] = (totalsByMemberOwed[s.memberId] || 0) + Number(s.amount);
        });
      });
      
      const summaryData = sheetMembers.map((m: Member) => ({
        'Member': isActive(m) ? m.name : `${m.name} (removed)`,
        'Total Paid': totalsByMemberPaid[m.id] || 0,
        'Total Owed': totalsByMemberOwed[m.id] || 0,
        'Net Balance': (totalsByMemberPaid[m.id] || 0) - (totalsByMemberOwed[m.id] || 0)
      }));
      
      // Create workbook with multiple sheets
      const wb = XLSX.utils.book_new();
      const expensesWs = XLSX.utils.json_to_sheet(expensesData);
      const summaryWs = XLSX.utils.json_to_sheet(summaryData);
      
      XLSX.utils.book_append_sheet(wb, expensesWs, 'Expenses');
      XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');
      
      XLSX.writeFile(wb, `${current.name.replace(/\s+/g,'_')}_expenses.xlsx`);
    }}
  >
    Export XLSX
  </button>
</div>
                </div>
              </div>
            </div>
          </main>
        )}
      </div>

      {showNew && <NewTripModal onClose={() => setShowNew(false)} onCreate={createTrip} />}
      {current && pendingRemoval && (
        <RemoveMemberModal
          member={pendingRemoval}
          trip={current}
          onClose={() => setPendingRemoval(null)}
          onConfirm={confirmRemoval}
        />
      )}
    </div>
  );
}