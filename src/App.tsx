import React, { useEffect, useState } from 'react';
import Landing from './Landing';
import ThemeToggle, { useTheme } from './ThemeToggle';
import SignIn, { useSession, signOut } from './SignIn';
import { isBackendConfigured } from './supabase';

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
  // The single payer. Kept as the canonical field so trips saved before split
  // payments existed still load, and so it can carry the first payer when
  // several people paid.
  payerId: string;
  // Present only when more than one person put money in. When absent, payerId
  // covered the whole total. Never read this directly, use payersOf().
  payers?: Split[];
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
// is what these amounts are read in. Never parse this back into a number,
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

// Who actually put money in, and how much. An expense saved before split
// payments existed has no `payers`, and for it the single payerId covered the
// whole total. Every part of the app that credits a payment goes through here,
// so there is one definition rather than a fallback repeated six times.
export function payersOf(e: Expense): Split[] {
  if (e.payers && e.payers.length > 0) return e.payers;
  return [{ memberId: e.payerId, amount: Number(e.total) }];
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
      payersOf(e).some((pay: Split) => pay.memberId === m.id) ||
      e.splits.some((s: Split) => s.memberId === m.id)
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
    paidCount: trip.expenses.filter((e: Expense) =>
      payersOf(e).some((pay: Split) => pay.memberId === memberId)
    ).length,
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

// One authored set, drawn on a 24-grid at a single 1.75 stroke weight, so the
// expense list reads as a system rather than a pile of borrowed glyphs.
const CATEGORY_PATHS: Record<string, string> = {
  bus: 'M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10M4 16h16M4 16v2m16-2v2M7 8h10M7 12h.01M17 12h.01',
  auto: 'M5 17a2 2 0 1 0 4 0 2 2 0 1 0-4 0M15 17a2 2 0 1 0 4 0 2 2 0 1 0-4 0M5 17H4v-5l3-6h7l3 6h1a2 2 0 0 1 2 2v3h-2M9 17h6',
  petrol: 'M5 20V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15M3 20h12M6 9h6M16 8l2 2v7a1.5 1.5 0 0 0 3 0v-6l-2-2',
  car: 'M6 17a2 2 0 1 0 4 0 2 2 0 1 0-4 0M14 17a2 2 0 1 0 4 0 2 2 0 1 0-4 0M6 17H3v-4l2-5h9l3 5h3v4h-2M10 17h4M5 13h14',
  hotel: 'M3 20V9l9-5 9 5v11M3 20h18M9 20v-5h6v5M8 11h.01M16 11h.01',
  food: 'M6 3v8a2 2 0 0 0 4 0V3M8 11v10M18 3c-1.5 1.5-2 3.5-2 6v3h4V9c0-2.5-.5-4.5-2-6M18 12v9',
  other: 'M12 8v.01M12 11v5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
};

const CATEGORY_TINT: Record<string, string> = {
  bus: '199 88 40',
  auto: '176 132 16',
  petrol: '90 118 60',
  car: '52 118 128',
  hotel: '96 96 168',
  food: '184 78 96',
  other: '124 116 104',
};

function CategoryIcon({ category, className = 'h-4 w-4' }: { category: string; className?: string }) {
  const d = CATEGORY_PATHS[category] ?? CATEGORY_PATHS.other;
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d={d} stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function categoryStyle(category: string): React.CSSProperties {
  const tint = CATEGORY_TINT[category] ?? CATEGORY_TINT.other;
  return { color: `rgb(${tint})`, backgroundColor: `rgb(${tint} / 0.10)` };
}

export interface ExpenseDraft {
  title: string;
  // Amounts keyed by member id. Empty means one person paid the whole total.
  payerAmounts?: Record<string, string>;
  total: string;
  method: 'equal' | 'unequal';
  selected: string[];
  customSplits: Record<string, string>;
  members: Member[];
}

export type ExpenseErrors = Partial<Record<'title' | 'total' | 'participants' | 'splits' | 'payers', string>>;

// Validation is pure and separate from the form so it can be tested directly
// and reused by an edit flow. Returns every problem at once rather than
// stopping at the first, so the user fixes one round instead of three.
export function validateExpense(d: ExpenseDraft): { errors: ExpenseErrors; splits: Split[]; payers: Split[] } {
  const errors: ExpenseErrors = {};
  if (!d.title.trim()) errors.title = 'Give this expense a name.';

  const amount = Number(d.total);
  if (!d.total.trim()) errors.total = 'Enter an amount.';
  else if (!Number.isFinite(amount)) errors.total = 'That is not a number.';
  else if (amount <= 0) errors.total = 'Amount must be more than zero.';

  // Whoever paid must add up to the same total as whoever owes, or the ledger
  // is wrong in a way that only shows up much later in the settlement.
  const payerEntries: Split[] = d.payerAmounts
    ? d.members
        .map((m: Member) => ({ memberId: m.id, amount: Number(d.payerAmounts?.[m.id] || 0) }))
        .filter((e: Split) => Number.isFinite(e.amount) && e.amount > 0)
    : [];
  if (payerEntries.length > 0 && Number.isFinite(amount)) {
    const paid = payerEntries.reduce((a: number, b: Split) => a + b.amount, 0);
    if (Math.abs(paid - amount) > 0.01) {
      const diff = amount - paid;
      errors.payers = diff > 0
        ? `₹${currency(diff)} of the total is unaccounted for.`
        : `₹${currency(-diff)} more was paid than the total.`;
    }
  }

  let splits: Split[] = [];
  if (d.method === 'equal') {
    const targets = d.selected.filter((id: string) => d.members.some((m: Member) => m.id === id));
    if (targets.length === 0) errors.participants = 'Pick at least one person to split between.';
    else if (Number.isFinite(amount) && amount > 0) splits = allocateEqually(amount, targets);
  } else {
    const entries: Split[] = d.members
      .map((m: Member) => ({ memberId: m.id, amount: Number(d.customSplits[m.id] || 0) }))
      .filter((e: Split) => Number.isFinite(e.amount) && e.amount > 0);
    const sum = entries.reduce((s: number, e: Split) => s + e.amount, 0);
    if (entries.length === 0) {
      errors.splits = 'Enter at least one amount.';
    } else if (Number.isFinite(amount) && Math.abs(sum - amount) > 0.01) {
      const diff = amount - sum;
      errors.splits = diff > 0
        ? `₹${currency(diff)} short of the total.`
        : `₹${currency(-diff)} over the total.`;
    } else {
      splits = entries;
    }
  }
  return { errors, splits, payers: errors.payers ? [] : payerEntries };
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
    <section className="overflow-hidden rounded-2xl border border-rule bg-surface">
      <div className="grid gap-8 p-8 sm:p-12 lg:grid-cols-2 lg:items-center">
        <div>
          <h2 className="font-display text-4xl leading-[1.05] tracking-tight text-ink sm:text-5xl">
            Split trip costs.<br />Settle up in the fewest payments.
          </h2>
          <p className="mt-4 max-w-md text-ink-muted">
            Add everyone who came, log what each person paid, and get the shortest
            list of transfers that squares the whole group up.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <button
              className="inline-flex items-center justify-center rounded-full bg-ink px-5 py-2.5 font-medium text-canvas transition-colors hover:bg-ink/88"
              onClick={onCreate}
            >
              Create your first trip
            </button>
            <button
              className="inline-flex items-center justify-center rounded-full border border-rule-strong px-5 py-2.5 font-medium text-ink transition-colors hover:bg-sunken"
              onClick={onSample}
            >
              Try a sample trip
            </button>
          </div>
        </div>

        {/* A still of the actual output, not decoration. aria-hidden because
            it repeats what the copy already says. */}
        <div aria-hidden className="rounded-xl bg-sunken p-5">
          <div className="space-y-2">
            {[
              { from: 'Asha', to: 'Bilal', amt: '1,479.17' },
              { from: 'Chetan', to: 'Bilal', amt: '779.16' },
              { from: 'Divya', to: 'Bilal', amt: '2,062.50' },
            ].map((r) => (
              <div
                key={r.from}
                className="flex items-center justify-between rounded-lg bg-surface px-3 py-2.5 text-sm border border-rule"
              >
                <span className="flex items-center gap-2 text-ink">
                  {r.from}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-ink-subtle">
                    <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {r.to}
                </span>
                <span className="font-semibold tnum text-ink">₹{r.amt}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-xs text-ink-subtle">
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

// role="alert" so a screen reader announces the problem when it appears,
// rather than the user discovering it only on the next tab stop.
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-sm text-debit">
      {message}
    </p>
  );
}

// Both dialogs were missing Escape, click-outside and focus containment. One
// shell so those behaviours exist once and cannot drift apart.
function Modal({ onClose, labelledBy, width, children }: {
  onClose: () => void;
  labelledBy: string;
  width: string;
  children: React.ReactNode;
}) {
  const panel = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(
      panel.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((el) => !el.hasAttribute('disabled'));

    focusables()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`w-full ${width} rounded-2xl border border-rule bg-surface p-6 shadow-modal animate-rise`}
      >
        {children}
      </div>
    </div>
  );
}

function NewTripModal({ onClose, onCreate }: NewTripModalProps) {
  const [name, setName] = useState<string>('');
  const [error, setError] = useState<string>('');

  const create = () => {
    if (!name.trim()) return setError('Give the trip a name.');
    onCreate({ id: uid('t_'), name: name.trim(), members: [], expenses: [] });
    onClose();
  };

  // Naming a trip from a blank field is harder than it looks, so offer a few
  // real shapes rather than leaving the box empty.
  const suggestions = ['Goa weekend', 'Manali, December', 'Cousin’s wedding', 'Office offsite'];

  return (
    <Modal onClose={onClose} labelledBy="new-trip-title" width="max-w-md">
      <h3 id="new-trip-title" className="font-display text-2xl tracking-tight">
        Name the trip
      </h3>
      <p className="mt-1.5 text-sm text-ink-muted">
        You will add who came, and what they paid for, next.
      </p>

      <input
        autoFocus
        className={`mt-5 w-full rounded-full bg-surface px-4 py-3 text-[1.05rem] border transition focus:border-accent ${error ? 'border-debit' : 'border-rule-strong'}`}
        value={name}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setName(e.target.value); if (error) setError(''); }}
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') create(); }}
        placeholder="Indore, three nights"
        aria-invalid={!!error}
        aria-describedby={error ? 'new-trip-error' : undefined}
      />
      <FieldError id="new-trip-error" message={error} />

      <div className="mt-3 flex flex-wrap gap-2">
        {suggestions.map((sug) => (
          <button
            key={sug}
            type="button"
            onClick={() => { setName(sug); setError(''); }}
            className="rounded-full border border-rule px-3 py-1.5 text-sm text-ink-muted transition-colors hover:border-accent hover:bg-accent-soft hover:text-ink"
          >
            {sug}
          </button>
        ))}
      </div>

      <div className="mt-7 flex items-center justify-end gap-2 border-t border-rule pt-5">
        <button
          className="rounded-full px-4 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-ink/88"
          onClick={create}
        >
          Create trip
        </button>
      </div>
    </Modal>
  );
}

function RemoveMemberModal({ member, trip, onClose, onConfirm }: RemoveMemberModalProps) {
  const impact = removalImpact(trip, member.id);
  return (
    <Modal onClose={onClose} labelledBy="remove-member-title" width="max-w-lg">
      <h3 id="remove-member-title" className="font-display text-xl tracking-tight mb-1">Remove {member.name}?</h3>
      <div className="text-sm text-ink-muted mb-4">
        {impact.involvedCount === 0
          ? 'They are not part of any expense yet.'
          : `They are a participant in ${impact.involvedCount} expense${impact.involvedCount === 1 ? '' : 's'}.`}
        {impact.paidCount > 0 &&
          ` They also paid for ${impact.paidCount} expense${impact.paidCount === 1 ? '' : 's'}, and those payments stay in the summary either way.`}
      </div>

      <div className="space-y-3">
        <button
          className="w-full rounded-xl border border-rule p-4 text-left transition-colors hover:border-accent hover:bg-accent-soft"
          onClick={() => onConfirm('redistribute')}
        >
          <div className="font-medium">Remove and split their share</div>
          <div className="text-sm text-ink-muted mt-1">
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
          className="w-full rounded-xl border border-rule p-4 text-left transition-colors hover:border-accent hover:bg-accent-soft"
          onClick={() => onConfirm('keep')}
        >
          <div className="font-medium">Remove from future expenses only</div>
          <div className="text-sm text-ink-muted mt-1">
            Every existing expense stays exactly as recorded. {member.name} just stops
            being offered when you add new ones.
          </div>
        </button>
      </div>

      <div className="flex justify-end mt-4">
      <button className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-sunken" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function TripCard({ trip, onOpen, onDelete }: TripCardProps) {
  const total = trip.expenses.reduce((s: number, e: Expense) => s + Number(e.total), 0);
  return (
    <div className="rounded-2xl border border-rule bg-surface p-5 transition-colors hover:border-rule-strong">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-display text-lg tracking-tight">{trip.name}</h3>
          <div className="text-sm text-ink-muted">Members: {trip.members.filter(isActive).length} • Expenses: {trip.expenses.length}</div>
        </div>
        <div className="text-right">
          <div className="text-sm text-ink-muted">Total</div>
          <div className="font-bold tnum">₹{currency(total)}</div>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button className="flex-1 inline-flex min-h-[2.75rem] items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-ink/88" onClick={() => onOpen(trip.id)}>Open</button>
        <button className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-sunken" onClick={() => onDelete(trip.id)}>Delete</button>
      </div>
    </div>
  );
}

function MemberList({ members, addMember, onRequestRemove }: MemberListProps) {
  const [name, setName] = useState<string>('');
  return (
    <div className="rounded-2xl border border-rule bg-surface p-5">
      <h2 className="font-display text-xl tracking-tight mb-3">Members</h2>
      <div className="flex gap-2 mb-3">
        <input 
          value={name} 
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} 
          placeholder="Member name" 
          className="min-w-[9rem] flex-1 min-h-[2.75rem] rounded-full bg-surface px-4 py-3 text-sm border border-rule transition focus:border-accent" 
        />
        <button 
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-ink/88"
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
          <div key={m.id} className="flex min-h-[2.75rem] items-center gap-1.5 rounded-full border border-rule bg-surface py-1 pl-4 pr-1.5 text-sm">
            <div className="text-sm">{m.name}</div>
            <button className="grid h-10 min-w-[2.5rem] place-items-center rounded-full px-2 text-xs text-ink-subtle transition-colors hover:bg-debit-soft hover:text-debit" onClick={() => onRequestRemove(m)} aria-label={`Remove ${m.name}`}>remove</button>
          </div>
        ))}
        {members.length === 0 && <div className="text-sm text-ink-subtle">No members yet</div>}
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
  const [errors, setErrors] = useState<ExpenseErrors>({});
  // Off by default: one person paying is the common case and must stay a
  // one-tap flow. Turning this on reveals an amount per member.
  const [splitPayment, setSplitPayment] = useState<boolean>(false);
  const [payerAmounts, setPayerAmounts] = useState<Record<string, string>>({});

  // Errors are raised on submit, then cleared as the user addresses them, so
  // the form never nags about a field they are still filling in.
  const clearError = (k: keyof ExpenseErrors) =>
    setErrors((prev: ExpenseErrors) => (prev[k] ? { ...prev, [k]: undefined } : prev));

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
      <div className="rounded-2xl border border-rule bg-surface p-5">
        <h2 className="font-display text-xl tracking-tight mb-3">Add expense</h2>
        <div className="text-sm text-ink-subtle">Add at least one member before recording an expense.</div>
      </div>
    );
  }

  const toggleSelected = (id: string) => {
    setSelected((prev: string[]) => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const submit = () => {
    const { errors: found, splits, payers } = validateExpense({
      title, total, method, selected, customSplits, members,
      payerAmounts: splitPayment ? payerAmounts : undefined,
    });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    onAdd({
      id: uid('e_'),
      title: title.trim(),
      // The first payer stays in payerId so anything reading the old field
      // still sees a real person rather than an empty string.
      payerId: payers.length > 0 ? payers[0].memberId : payerId,
      ...(payers.length > 1 ? { payers } : {}),
      total: Number(total),
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
    setPayerAmounts({});
    setSplitPayment(false);
    setErrors({});
  };

  return (
    <div className="rounded-2xl border border-rule bg-surface p-5">
      <h5 className="font-medium mb-2">Add expense</h5>
      <input
        value={title}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setTitle(e.target.value); clearError('title'); }}
        placeholder="Expense title"
        aria-invalid={!!errors.title}
        aria-describedby={errors.title ? 'expense-title-error' : undefined}
        className={`w-full min-h-[2.75rem] rounded-full bg-surface px-4 py-3 text-sm border transition ${errors.title ? 'border-debit' : 'border-rule focus:border-accent'}`}
      />
      <FieldError id="expense-title-error" message={errors.title} />
      <div className="mb-2" />
      <div className="mb-2 flex flex-wrap gap-2">
        <select 
          value={payerId} 
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPayerId(e.target.value)} 
          className="min-w-[9rem] flex-1 min-h-[2.75rem] rounded-full bg-surface px-4 py-3 text-sm border border-rule transition focus:border-accent"
        >
          {members.map((m: Member) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <input
          value={total}
          inputMode="decimal"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setTotal(e.target.value); clearError('total'); }}
          placeholder="Total"
          aria-invalid={!!errors.total}
          aria-describedby={errors.total ? 'expense-total-error' : undefined}
          className={`w-28 rounded-lg bg-surface p-2.5 text-sm tnum border transition ${errors.total ? 'border-debit' : 'border-rule focus:border-accent'}`}
        />
        <select 
          value={category} 
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCategory(e.target.value)} 
          className="min-w-[8rem] flex-1 min-h-[2.75rem] rounded-full bg-surface px-4 py-3 text-sm border border-rule bg-surface transition focus:border-accent"
        >
          {categories.map((c: string) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <FieldError id="expense-total-error" message={errors.total} />

      <div className="mb-3">
        <label className="inline-flex min-h-[2.75rem] cursor-pointer items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={splitPayment}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setSplitPayment(e.target.checked);
              clearError('payers');
            }}
          />
          More than one person paid
        </label>

        {splitPayment && (
          <div className="mt-2 space-y-2 rounded-xl border border-rule p-3">
            <p className="text-sm text-ink-subtle">
              How much each of them put in. It has to add up to the total.
            </p>
            {members.map((m: Member) => (
              <div key={m.id} className="flex items-center gap-2">
                <div className="w-28 truncate text-sm">{m.name}</div>
                <input
                  inputMode="decimal"
                  className={`flex-1 min-h-[2.75rem] rounded-full bg-surface px-4 py-3 text-sm tnum border transition ${errors.payers ? 'border-debit' : 'border-rule focus:border-accent'}`}
                  value={payerAmounts[m.id] ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setPayerAmounts((prev) => ({ ...prev, [m.id]: e.target.value }));
                    clearError('payers');
                  }}
                  placeholder="0"
                />
              </div>
            ))}
            <FieldError id="expense-payers-error" message={errors.payers} />
          </div>
        )}
      </div>

      <div className="mb-2">
        <div className="text-sm mb-1">Split method</div>
        <div className="flex gap-2">
          <label className={`flex min-h-[2.75rem] items-center gap-2 rounded-full border border-rule px-4 py-2 ${method==='equal' ? 'bg-sunken' : ''}`}>
            <input 
              type="radio" 
              name="method" 
              checked={method==='equal'} 
              onChange={() => setMethod('equal')} 
            /> Equal
          </label>
          <label className={`flex min-h-[2.75rem] items-center gap-2 rounded-full border border-rule px-4 py-2 ${method==='unequal' ? 'bg-sunken' : ''}`}>
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
            <label key={m.id} className={`flex min-h-[2.75rem] cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors ${selected.includes(m.id) ? 'border-accent bg-accent-soft' : 'border-rule hover:bg-sunken'}`}>
              <input
                type="checkbox"
                checked={selected.includes(m.id)}
                onChange={() => { toggleSelected(m.id); clearError('participants'); }}
              /> {m.name}
            </label>
          ))}
        </div>
        <FieldError id="expense-participants-error" message={errors.participants} />
      </div>

      {method === 'unequal' && (
        <div className="mb-2">
          <div className="text-sm mb-1">Custom split amounts (must sum to total)</div>
          <div className="flex flex-col gap-2">
            {members.map((m: Member) => (
              <div key={m.id} className="flex gap-2 items-center">
                <div className="w-28 text-sm">{m.name}</div>
                <input
                  inputMode="decimal"
                  className={`flex-1 rounded-lg bg-surface p-2.5 text-sm tnum border transition ${errors.splits ? 'border-debit' : 'border-rule focus:border-accent'}`}
                  value={customSplits[m.id] ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setCustomSplits(prev => ({ ...prev, [m.id]: e.target.value })); clearError('splits'); }}
                  placeholder="0"
                />
              </div>
            ))}
          </div>
          <FieldError id="expense-splits-error" message={errors.splits} />
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button 
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-sunken" 
          onClick={() => { setTitle(''); setTotal(''); setMethod('equal'); setCustomSplits({}); setErrors({}); }}
        >
          Reset
        </button>
        <button className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-ink/88" onClick={submit}>Add expense</button>
      </div>
    </div>
  );
}

function ExpenseList({ expenses, members, onDelete }: ExpenseListProps) {
  const nameOf = (id: string): string => members.find((m: Member) => m.id === id)?.name || 'Unknown';
  return (
    <div className="rounded-2xl border border-rule bg-surface p-5">
      <h2 className="font-display text-xl tracking-tight">Expenses</h2>
      {expenses.length === 0 ? (
        <p className="mt-2 text-sm text-ink-subtle">No expenses yet.</p>
      ) : (
        // Rows separated by rules rather than boxed individually: a list of
        // ringed cards inside a card is three nested containers deep.
        <ul className="mt-2 divide-y divide-rule">
          {expenses.map((e: Expense) => {
            const share = isEqualSplit(e) && e.splits.length > 1
              ? `split ${e.splits.length} ways · ₹${currency(e.splits[0].amount)} each`
              : `${e.splits.length} custom share${e.splits.length === 1 ? '' : 's'}`;
            return (
              <li key={e.id} className="group flex items-center gap-3 py-3">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                  style={categoryStyle(e.category)}
                  title={e.category}
                >
                  <CategoryIcon category={e.category} />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{e.title}</div>
                  <div className="truncate text-sm text-ink-muted">
                    {payersOf(e).map((pay: Split) => nameOf(pay.memberId)).join(' and ')} paid · {share}
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  <div className="font-semibold tnum">₹{currency(e.total)}</div>
                  <div className="text-xs text-ink-subtle">
                    {new Date(e.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </div>
                </div>

                <button
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-subtle transition-opacity hover:bg-debit-soft hover:text-debit sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
                  onClick={() => onDelete(e.id)}
                  aria-label={`Remove ${e.title}`}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-4 w-4">
                    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
                      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
    payersOf(e).forEach((pay: Split) => {
      totalsByMemberPaid[pay.memberId] = (totalsByMemberPaid[pay.memberId] || 0) + Number(pay.amount);
    });
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

  // Simplified settlement suggestion: who owes who, greedy algorithm
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
      // Round numerically rather than parsing currency()'s formatted output,
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
    <div className="rounded-2xl border border-rule bg-surface p-5">
      {/* The settlement list is the product: it is the one thing someone opens
          this app to find out. It leads, and everything below it is the
          evidence for it. */}
      <div className="mb-5">
        <h2 className="font-display text-xl tracking-tight">Settle up</h2>
        {settle.length === 0 ? (
          <div className="mt-2 rounded-xl border border-credit/25 bg-credit-soft px-4 py-3 text-sm font-medium text-credit">
            All settled. Nobody owes anybody.
          </div>
        ) : (
          <>
            <div className="mt-2 space-y-2">
              {settle.map((s, idx: number) => (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-3 rounded-xl bg-sunken px-4 py-3"
                >
                  <span className="flex min-w-0 items-center gap-2 font-medium text-ink">
                    <span className="truncate">{s.from}</span>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-ink-subtle">
                      <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="truncate">{s.to}</span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-lg font-semibold tnum text-ink">
                    ₹{currency(s.amount)}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-ink-subtle">
              {settle.length === 1 ? 'One transfer clears' : `${settle.length} transfers clear`} the whole group.
            </div>
          </>
        )}
      </div>

      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-rule pt-4">
        <div>
          <span className="text-sm text-ink-muted">Trip total </span>
          <span className="font-display text-2xl tracking-tight tnum">₹{currency(totalTrip)}</span>
        </div>
        <div className="text-sm text-ink-subtle tnum">₹{currency(perHead)} per head</div>
      </div>

      <div className="mb-5">
        <h3 className="mb-2 font-display text-base tracking-tight">Paid vs owed</h3>
        <div className="divide-y divide-rule border-y border-rule">
          {net.map(n => (
            <div key={n.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="font-medium truncate">
                  {n.name}
                  {n.removed && <span className="ml-2 text-xs font-normal text-ink-subtle">(removed)</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-ink-subtle tnum">
                  <span className="whitespace-nowrap">paid ₹{currency(n.paid)}</span>
                  <span className="whitespace-nowrap">owes ₹{currency(n.owed)}</span>
                </div>
              </div>
              {/* Direction is carried by the word, not only by colour, so the
                  row still reads correctly without colour vision. */}
              <div className={`shrink-0 whitespace-nowrap text-right text-sm font-semibold tnum ${n.net>=0 ? 'text-credit' : 'text-debit'}`}>
                <span className="block text-xs font-normal text-ink-subtle">
                  {n.net >= 0 ? 'receives' : 'pays'}
                </span>
                ₹{currency(Math.abs(n.net))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 font-display text-base tracking-tight">Where it went</h3>
        {Object.keys(categoryTotals).length === 0 ? (
          <div className="text-sm text-ink-subtle">No expenses yet</div>
        ) : (
          <div className="space-y-2.5">
            {Object.entries(categoryTotals)
              .sort((a, b) => b[1] - a[1])
              .map(([cat, amt]: [string, number]) => {
                const pct = totalTrip > 0 ? (amt / totalTrip) * 100 : 0;
                return (
                  <div key={cat}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="capitalize text-ink">{cat}</span>
                      <span className="tnum text-ink-muted">
                        ₹{currency(amt)}
                        <span className="ml-2 text-ink-subtle">{Math.round(pct)}%</span>
                      </span>
                    </div>
                    {/* Decorative: the figure and share are both stated above,
                        so the bar adds shape rather than information. */}
                    <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TripExpenseApp() {
  const [trips, setTrips] = useLocalState<Trip[]>('trips_v1', []);
  const [showNew, setShowNew] = useState<boolean>(false);
  const [openTripId, setOpenTripId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Member | null>(null);
  // SheetJS arrives in a lazy 139 kB chunk. On a slow connection the button
  // would sit silent for seconds and get clicked repeatedly.
  const [exportState, setExportState] = useState<'idle' | 'working' | 'failed'>('idle');
  // The landing page is the entry surface until someone actually starts.
  const [seenLanding, setSeenLanding] = useLocalState<boolean>('hisaab_seen_landing', false);
  const [theme, toggleTheme] = useTheme();
  const { user } = useSession();
  const [signInReason, setSignInReason] = useState<string | null>(null);

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

  // Seed a worked example and open it straight away. The point is to show the
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

  if (!seenLanding) {
    return (
      <>
        <Landing
          theme={theme}
          onToggleTheme={toggleTheme}
          signedIn={!!user}
          onSignIn={isBackendConfigured ? () => setSignInReason('Keep your trips across devices.') : undefined}
          onStart={() => { setSeenLanding(true); setShowNew(true); }}
          onSample={() => { setSeenLanding(true); loadSample(); }}
        />
        {signInReason !== null && (
          <Modal onClose={() => setSignInReason(null)} labelledBy="signin-title" width="max-w-md">
            <SignIn
              reason={signInReason || undefined}
              onClose={() => setSignInReason(null)}
              onSignedIn={() => setSignInReason(null)}
            />
          </Modal>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-canvas p-6 font-sans">
      <div className="max-w-6xl mx-auto">
        <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="font-display text-2xl tracking-tight">
              <button
                type="button"
                onClick={() => setSeenLanding(false)}
                title="Back to the Hisaab home page"
                className="rounded-full transition-opacity hover:opacity-70"
              >
                Hisaab
              </button>
            </h1>
            <p className="text-sm text-ink-subtle mt-1">
              Saved in this browser only. It will not follow you to another device.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            {isBackendConfigured && (
              user ? (
                <button
                  onClick={() => signOut()}
                  title={user.email || 'Signed in'}
                  className="inline-flex min-h-[2.75rem] items-center rounded-full px-4 py-2 text-sm font-medium text-ink-subtle transition-colors hover:bg-sunken hover:text-ink"
                >
                  Sign out
                </button>
              ) : (
                <button
                  onClick={() => setSignInReason('')}
                  className="inline-flex min-h-[2.75rem] items-center rounded-full px-4 py-2 text-sm font-medium text-ink-subtle transition-colors hover:bg-sunken hover:text-ink"
                >
                  Sign in
                </button>
              )
            )}
            {/* Destructive and irreversible, so it stays out of reach of the
                primary action and only appears when there is data to lose. */}
            {!current && trips.length > 0 && (
              <button
                className="rounded-full px-3 py-2 text-sm font-medium text-ink-subtle transition-colors hover:bg-debit-soft hover:text-debit"
                onClick={resetAllData}
              >
                Reset data
              </button>
            )}
            <button
              className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-ink/88"
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
          // Trip cards sit on the canvas rather than inside a panel: a card
          // holding cards is a container standing in for a heading.
          <main>
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule pb-3">
              <h2 className="font-display text-xl tracking-tight">Your trips</h2>
              <p className="text-sm text-ink-subtle tnum">
                {trips.length} trip{trips.length === 1 ? '' : 's'} · ₹{currency(trips.reduce((s: number, t: Trip) => s + t.expenses.reduce((ss: number, e: Expense) => ss + Number(e.total), 0), 0))} logged
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {trips.map((t: Trip) => (
                <TripCard key={t.id} trip={t} onOpen={openTrip} onDelete={deleteTrip} />
              ))}
            </div>
          </main>
        )}

        {current && (
          <main className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-2xl tracking-tight">{current.name}</h2>
                <div className="text-sm text-ink-muted">Members: {activeMembers.length} • Expenses: {current.expenses.length}</div>
              </div>
              <div className="flex gap-2">
                <button className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-sunken" onClick={closeTrip}>Back</button>
                <button 
                  className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full bg-debit px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-debit/88" 
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
                <div className="rounded-2xl border border-rule bg-surface p-5">
                  <h2 className="font-display text-xl tracking-tight mb-3">Actions</h2>
<div className="space-y-2">
  <button 
    className="w-full inline-flex min-h-[2.75rem] items-center justify-center rounded-full border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-sunken" 
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
            payersOf(exp).map((pay: Split) => `${nameOf(pay.memberId)} ${pay.amount}`).join('; '),
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
    className="w-full inline-flex min-h-[2.75rem] items-center justify-center rounded-full border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-sunken disabled:cursor-not-allowed disabled:text-ink-subtle disabled:hover:bg-transparent"
    disabled={exportState === 'working'}
    onClick={async () => {
      // SheetJS is bundled, not fetched from a CDN, so export works offline.
      // The import is dynamic so the ~400 KB library is code-split into its own
      // chunk and only downloaded when someone actually exports.
      if (exportState === 'working') return;
      setExportState('working');
      let XLSX;
      try {
        XLSX = await import('xlsx');
      } catch (err) {
        setExportState('failed');
        return;
      }

      const nameOf = (id: string): string => current.members.find((m: Member) => m.id === id)?.name || 'Unknown';
      
      // Create expenses sheet data
      const expensesData = current.expenses.flatMap((exp: Expense) => 
        exp.splits.map((split: Split) => ({
          'Date': new Date(exp.date).toLocaleDateString(),
          'Title': exp.title,
          'Category': exp.category,
          'Paid By': payersOf(exp).map((pay: Split) => `${nameOf(pay.memberId)} ${pay.amount}`).join('; '),
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
        payersOf(e).forEach((pay: Split) => {
          totalsByMemberPaid[pay.memberId] = (totalsByMemberPaid[pay.memberId] || 0) + Number(pay.amount);
        });
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
      setExportState('idle');
    }}
  >
    {exportState === 'working' ? 'Preparing…' : 'Export XLSX'}
  </button>
  {exportState === 'failed' && (
    <p role="alert" className="text-sm text-debit">
      Could not load the spreadsheet library. Export to CSV instead.
    </p>
  )}
</div>
                </div>
              </div>
            </div>
          </main>
        )}
      </div>

      {showNew && <NewTripModal onClose={() => setShowNew(false)} onCreate={createTrip} />}
      {signInReason !== null && (
        <Modal onClose={() => setSignInReason(null)} labelledBy="signin-title" width="max-w-md">
          <SignIn
            reason={signInReason || undefined}
            onClose={() => setSignInReason(null)}
            onSignedIn={() => setSignInReason(null)}
          />
        </Modal>
      )}
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