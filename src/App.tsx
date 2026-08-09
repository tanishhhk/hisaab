import React, { useEffect, useState, useRef } from 'react';
import * as htmlToImage from 'html-to-image';
import Landing, { LoadingScreen } from './Landing';
import { AnimatePresence, motion } from 'framer-motion';
import ThemeToggle, { useTheme } from './ThemeToggle';
import SignIn, { useSession, signOut } from './SignIn';
import { isBackendConfigured } from './supabase';
import { newId, migrateLegacyIds, tripsKey } from './sync/ids';
import { useRoute } from './routes';
import { useSync } from './sync/useSync';
import SyncStatus from './SyncStatus';

// TypeScript Interfaces
export interface Member {
  id: string;
  name: string;
  // Members are soft-deleted so their past payments and debts stay in the
  // ledger after removal. Absent means active, so trips saved before this
  // field existed keep working without migration.
  active?: boolean;
  // The server's stamp for this member alone. Sync merges members one at a
  // time, so each carries its own last-write mark rather than the trip's.
  // Absent means never synced.
  updatedAt?: string;
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
  // As with Member: this expense's own server stamp. Two people adding
  // different expenses must not overwrite each other, so the merge happens
  // per expense and needs a per-expense mark.
  updatedAt?: string;
}

export interface Trip {
  id: string;
  name: string;
  members: Member[];
  expenses: Expense[];
  // Sort key for the trip list. Stable under edits, which is why the list is
  // ordered by this and not by updatedAt.
  createdAt?: string;
  // Last-write-wins stamp, and always the value the server returned rather
  // than a client guess: the trips_touch trigger rewrites updated_at on every
  // update, so a guess would make the remote copy look permanently newer and
  // re-pull on every load. Absent means this trip has never synced.
  updatedAt?: string;
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
  editingExpense?: Expense | null;
  onUpdate?: (expense: Expense) => void;
  onCancel?: () => void;
  existingCategories?: string[];
  tripName?: string;
}

interface ExpenseListProps {
  expenses: Expense[];
  members: Member[];
  onDelete: (id: string) => void;
  onEdit: (expense: Expense) => void;
}

interface SummaryPanelProps {
  trip: Trip;
  onSettle?: (settlements: {fromId: string, toId: string, amount: number}[]) => void;
}

// TripExpenseApp.tsx
// Single-file React component (Tailwind CSS expected in parent project)
// Default export at bottom

// Data model (saved to localStorage):
// trips: [{ id, name, members: [{id,name}], expenses: [{id, title, payerId, total, splits: [{memberId, amount}], category, date}] }]

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
  const m = (name: string): Member => ({ id: newId(), name });
  const [asha, bilal, chetan, divya] = [m('Asha'), m('Bilal'), m('Chetan'), m('Divya')];
  const members = [asha, bilal, chetan, divya];
  const all = members.map((x: Member) => x.id);
  const day = (offset: number) =>
    new Date(Date.now() - offset * 86400000).toISOString();

  const expense = (
    title: string, payer: Member, total: number,
    splits: Split[], category: string, offset: number
  ): Expense => ({ id: newId(), title, payerId: payer.id, total, splits, category, date: day(offset) });

  return {
    id: newId(),
    createdAt: new Date().toISOString(),
    name: 'Weekend trip (sample)',
    members,
    expenses: [
      expense('Hotel, two nights', bilal, 8600, allocateEqually(8600, all), 'hotel', 5),
      expense('Night market food', asha, 2400, allocateEqually(2400, all), 'food', 5),
      expense('Cab to the fort', chetan, 3500, allocateEqually(3500, [asha.id, bilal.id, chetan.id]), 'car', 4),
      expense('Petrol', asha, 1000, [{ memberId: asha.id, amount: 600 }, { memberId: divya.id, amount: 400 }], 'petrol', 4),
      expense('Breakfast, day two', divya, 1450, allocateEqually(1450, all), 'food', 3),
    ],
  };
}

function EmptyState({ onCreate, onReadGuide }: { onCreate: () => void; onReadGuide: () => void }) {
  return (
    <section className="overflow-hidden rounded-3xl border border-rule bg-surface">
      <div className="grid gap-8 p-8 sm:p-12 lg:grid-cols-2 lg:items-center">
        <div>
          <h2 className="font-display text-4xl leading-[1.05] tracking-tight text-ink sm:text-5xl">
            Split trip costs.<br />Settle up in the fewest payments.
          </h2>
          <p className="mt-4 max-w-md text-ink-muted">
            Add everyone who came, log what each person paid, and get the shortest
            list of transfers that squares the whole group up.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              className="inline-flex min-h-[3rem] items-center justify-center rounded-full bg-ink px-6 py-2.5 font-medium text-canvas transition-colors hover:bg-ink/88"
              onClick={onCreate}
            >
              Create your first trip
            </button>
            <button
              className="inline-flex min-h-[3rem] items-center justify-center rounded-full border border-rule-strong px-6 py-2.5 font-medium text-ink transition-colors hover:bg-sunken"
              onClick={onReadGuide}
            >
              Back to start
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
  const read = (k: string): T => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : initial;
    } catch (e) {
      return initial;
    }
  };
  const [state, setState] = useState<T>(() => read(key));
  // The key changes when someone signs in or out, and the state has to follow
  // it. Without this, a sign-in would write the anonymous trips into the
  // account's key on the next render.
  const previousKey = React.useRef(key);
  useEffect(() => {
    if (previousKey.current === key) return;
    previousKey.current = key;
    setState(read(key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
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
    onCreate({ id: newId(), name: name.trim(), members: [], expenses: [], createdAt: new Date().toISOString() });
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
        placeholder="Hill trip, three nights"
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
    <div className="rounded-3xl border border-rule bg-surface p-6 sm:p-8 transition-all hover:border-rule-strong hover:shadow-sm flex flex-col justify-between group">
      <div>
        <div className="flex justify-between items-start gap-4">
          <div>
            <h3 className="font-display text-2xl tracking-tight text-ink group-hover:text-accent transition-colors">{trip.name}</h3>
            <div className="mt-1 text-sm text-ink-muted">Members: {trip.members.filter(isActive).length} • Expenses: {trip.expenses.length}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-medium uppercase tracking-wider text-ink-subtle mb-0.5">Total</div>
            <div className="font-mono text-xl font-medium tnum text-ink">₹{currency(total)}</div>
          </div>
        </div>
      </div>
      <div className="mt-8 flex gap-3">
        <button className="flex-1 inline-flex min-h-[3rem] items-center justify-center rounded-full bg-ink px-5 py-2.5 text-[0.95rem] font-medium text-canvas transition-colors hover:bg-ink/88" onClick={() => onOpen(trip.id)}>Open</button>
        <button className="inline-flex min-h-[3rem] items-center justify-center rounded-full border border-rule-strong px-5 py-2.5 text-[0.95rem] font-medium text-ink transition-colors hover:bg-sunken" onClick={() => onDelete(trip.id)}>Delete</button>
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
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (!name.trim()) return; 
              addMember({ id: newId(), name: name.trim() });
              setName(''); 
            }
          }}
          placeholder="Member name" 
          className="min-w-[9rem] flex-1 min-h-[2.75rem] rounded-full bg-surface px-4 py-3 text-sm border border-rule transition focus:border-accent" 
        />
        <button 
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-ink/88"
          onClick={() => { 
            if (!name.trim()) return; 
            addMember({ id: newId(), name: name.trim() });
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

const AVATAR_COLORS = [
  'bg-red-500 text-white',
  'bg-blue-500 text-white',
  'bg-green-500 text-white',
  'bg-yellow-500 text-white',
  'bg-purple-500 text-white',
  'bg-pink-500 text-white',
  'bg-indigo-500 text-white',
  'bg-teal-500 text-white',
  'bg-orange-500 text-white',
  'bg-cyan-500 text-white',
];

export function getAvatarColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function getInitials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

function ExpenseForm({ members, onAdd, editingExpense, onUpdate, onCancel, existingCategories = [], tripName }: ExpenseFormProps) {
  const [title, setTitle] = useState<string>('');
  const [payerId, setPayerId] = useState<string>('');
  const [total, setTotal] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [method, setMethod] = useState<'equal' | 'unequal'>('equal');
  const [selected, setSelected] = useState<string[]>(() => members.map((m: Member) => m.id));
  const [customSplits, setCustomSplits] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<ExpenseErrors>({});
  const [splitPayment, setSplitPayment] = useState<boolean>(false);
  const [payerAmounts, setPayerAmounts] = useState<Record<string, string>>({});
  const [showInvoice, setShowInvoice] = useState(false);
  const receiptRef = useRef<HTMLDivElement>(null);

  const downloadReceipt = async () => {
    if (receiptRef.current) {
      try {
        const dataUrl = await htmlToImage.toPng(receiptRef.current);
        const link = document.createElement('a');
        link.download = `receipt-${title.replace(/\s+/g, '-').toLowerCase() || 'expense'}.png`;
        link.href = dataUrl;
        link.click();
      } catch (err) {
        console.error('Failed to generate receipt', err);
      }
    }
  };

  // Key on the member IDs, not the array identity: the parent rebuilds
  // `members` on every render, so depending on [members] re-ran this (and wiped
  // the in-progress form) continuously. Reconcile instead of resetting, so
  // adding a member mid-entry no longer discards the current selection.
  const memberKey = members.map((m: Member) => m.id).join(',');
  useEffect(() => {
    if (editingExpense) return;
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
  }, [memberKey, editingExpense]);

  useEffect(() => {
    if (editingExpense) {
      setTitle(editingExpense.title);
      setPayerId(editingExpense.payerId);
      setTotal(String(editingExpense.total));
      setCategory(editingExpense.category);
      const isEq = isEqualSplit(editingExpense);
      setMethod(isEq ? 'equal' : 'unequal');
      setSelected(editingExpense.splits.map(s => s.memberId));
      if (!isEq) {
        const custom: Record<string, string> = {};
        editingExpense.splits.forEach(s => { custom[s.memberId] = String(s.amount); });
        setCustomSplits(custom);
      } else {
        setCustomSplits({});
      }
      if (editingExpense.payers) {
        setSplitPayment(true);
        const pay: Record<string, string> = {};
        editingExpense.payers.forEach(s => { pay[s.memberId] = String(s.amount); });
        setPayerAmounts(pay);
      } else {
        setSplitPayment(false);
        setPayerAmounts({});
      }
    }
  }, [editingExpense]);

  if (members.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-surface p-5">
        <h2 className="font-display text-xl tracking-tight mb-3">{editingExpense ? 'Edit expense' : 'Add expense'}</h2>
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

    if (editingExpense && onUpdate) {
      onUpdate({
        ...editingExpense,
        title: title.trim(),
        payerId: payers.length > 0 ? payers[0].memberId : payerId,
        payers,
        total: Number(total),
        splits,
        category,
      });
    } else {
      onAdd({
        id: newId(),
        title: title.trim(),
        payerId: payers.length > 0 ? payers[0].memberId : payerId,
        ...(payers.length > 1 ? { payers } : {}),
        total: Number(total),
        splits,
        category,
        date: new Date().toISOString()
      });
    }
    
    if (!editingExpense) {
      setTitle('');
      setTotal('');
      setSelected(members.map((m: Member) => m.id));
      setCustomSplits({});
      setMethod('equal');
      setPayerAmounts({});
      setSplitPayment(false);
      setErrors({});
    }
  };

  const clearError = (k: keyof ExpenseErrors) =>
    setErrors((prev: ExpenseErrors) => (prev[k] ? { ...prev, [k]: undefined } : prev));

  return (
    <div className="rounded-2xl border border-rule bg-surface p-5">
      <h5 className="font-medium mb-2">{editingExpense ? 'Edit expense' : 'Add expense'}</h5>
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
      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <div className="text-sm text-ink-muted">Who Paid?</div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-ink-muted hover:text-ink transition-colors bg-surface px-3 py-1.5 rounded-lg border border-rule-strong hover:border-ink hover:bg-sunken">
            <div className="relative flex items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={splitPayment}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setSplitPayment(e.target.checked);
                  if (e.target.checked) {
                    setPayerAmounts({ [payerId]: total });
                  } else {
                    setPayerAmounts({});
                  }
                  clearError('payers');
                }}
              />
              <div className="w-4 h-4 border-2 border-rule-strong rounded-[4px] bg-surface peer-checked:bg-ink peer-checked:border-ink transition-all"></div>
              <svg className="absolute inset-0 w-4 h-4 text-canvas opacity-0 peer-checked:opacity-100 scale-50 peer-checked:scale-100 transition-all duration-200 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </div>
            Multiple people paid
          </label>
        </div>
        <div className="flex gap-3 overflow-x-auto pb-2 pt-2 px-2 -mx-2 no-scrollbar">
          {members.map(m => {
            const isPayer = splitPayment ? (payerAmounts[m.id] !== undefined) : payerId === m.id;
            return (
              <button 
                key={m.id}
                type="button"
                onClick={() => { 
                  if (splitPayment) {
                    setPayerAmounts(prev => {
                      const next = { ...prev };
                      if (next[m.id] !== undefined) {
                        delete next[m.id];
                        // if we unselected the last one, maybe select someone else? 
                        // Let's just allow empty selection and show error.
                      } else {
                        next[m.id] = '';
                      }
                      return next;
                    });
                  } else {
                    setPayerId(m.id); 
                  }
                  clearError('payers'); 
                }}
                className={`flex flex-col items-center gap-1 min-w-[3.5rem] transition-transform ${isPayer ? 'scale-110 drop-shadow-md' : 'opacity-60 hover:opacity-100 grayscale hover:grayscale-0'}`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shadow-inner ${getAvatarColor(m.id)} ${isPayer ? 'ring-2 ring-offset-2 ring-accent' : ''}`}>
                  {getInitials(m.name)}
                </div>
                <span className="text-[10px] uppercase font-medium truncate max-w-full">{m.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="mb-4 flex flex-col md:flex-row items-start gap-4">
        <div className="flex-1 w-full">
          <input
            value={total}
            inputMode="decimal"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setTotal(e.target.value); clearError('total'); }}
            placeholder="Total Amount"
            aria-invalid={!!errors.total}
            aria-describedby={errors.total ? 'expense-total-error' : undefined}
            className={`w-full text-2xl font-bold rounded-xl bg-surface px-4 py-3 tnum border transition ${errors.total ? 'border-debit' : 'border-rule focus:border-accent'}`}
          />
          <div className="flex gap-2 mt-2">
             {['+100', '+500', '+1000'].map(val => (
                <button
                   key={val}
                   type="button"
                   onClick={() => {
                      const cur = Number(total) || 0;
                      setTotal(String(cur + Number(val.replace('+',''))));
                      clearError('total');
                   }}
                   className="flex-1 py-2 rounded-lg border border-rule bg-surface text-xs font-medium hover:bg-sunken transition-colors"
                >
                   {val}
                </button>
             ))}
             <button
                type="button"
                onClick={() => { setTotal(''); clearError('total'); }}
                className="flex-1 py-2 rounded-lg border border-rule bg-surface text-xs font-medium text-debit hover:bg-debit-soft transition-colors"
             >
                Clear
             </button>
          </div>
          <FieldError id="expense-total-error" message={errors.total} />
        </div>
        
        <div className="flex-1 w-full relative">
          <input
            list="category-options"
            value={category}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCategory(e.target.value)}
            placeholder="Category (e.g. food, fuel)"
            className="w-full min-h-[2.75rem] rounded-full bg-surface px-4 py-3 text-sm border border-rule transition focus:border-accent mb-2"
          />
          <datalist id="category-options">
            {existingCategories.map((c: string) => <option key={c} value={c} />)}
          </datalist>
          <div className="flex flex-wrap gap-1.5">
            {existingCategories.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`px-3 py-1 text-[13px] rounded-full border transition-colors ${category.toLowerCase() === c.toLowerCase() ? 'bg-ink text-canvas border-ink' : 'bg-surface text-ink-muted border-rule hover:bg-sunken'}`}
              >
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-3">
        {splitPayment && Object.keys(payerAmounts).length > 0 && (
          <div className="mb-4 space-y-2 rounded-xl border border-rule p-3">
            <p className="text-sm text-ink-subtle">
              How much each of them put in. It has to add up to the total.
            </p>
            {members.filter(m => payerAmounts[m.id] !== undefined).map((m: Member) => (
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

      <div className="mb-4">
        <div className="text-sm mb-2 text-ink-muted">Split method</div>
        <div className="flex gap-3">
          <label className={`flex-1 flex justify-center items-center gap-2 rounded-xl border-2 px-4 py-2.5 cursor-pointer transition-all ${method==='equal' ? 'bg-ink text-canvas border-ink shadow-sm' : 'bg-surface text-ink-muted border-rule-strong hover:bg-sunken hover:border-ink hover:text-ink'}`}>
            <input 
              type="radio" 
              name="method" 
              checked={method==='equal'} 
              onChange={() => setMethod('equal')} 
              className="sr-only"
            />
            <svg className={`w-4 h-4 ${method==='equal' ? 'opacity-100' : 'opacity-50'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"></path><path d="M5 17h14"></path></svg>
            <span className="font-medium text-sm">Equal</span>
          </label>
          <label className={`flex-1 flex justify-center items-center gap-2 rounded-xl border-2 px-4 py-2.5 cursor-pointer transition-all ${method==='unequal' ? 'bg-ink text-canvas border-ink shadow-sm' : 'bg-surface text-ink-muted border-rule-strong hover:bg-sunken hover:border-ink hover:text-ink'}`}>
            <input 
              type="radio" 
              name="method" 
              checked={method==='unequal'} 
              onChange={() => setMethod('unequal')} 
              className="sr-only"
            /> 
            <svg className={`w-4 h-4 ${method==='unequal' ? 'opacity-100' : 'opacity-50'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
            <span className="font-medium text-sm">Custom</span>
          </label>
        </div>
      </div>

      <div className="mb-4">
        <div className="text-sm mb-2 text-ink-muted">Who is splitting this cost?</div>
        <div className="flex flex-wrap gap-3">
          {members.map((m: Member) => {
            const isSelected = selected.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { toggleSelected(m.id); clearError('participants'); }}
                className={`flex items-center gap-2 rounded-full pr-3 p-1 border transition-all ${isSelected ? 'border-accent bg-accent-soft shadow-sm' : 'border-transparent opacity-50 grayscale hover:grayscale-0 hover:opacity-100'}`}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shadow-inner ${getAvatarColor(m.id)}`}>
                  {getInitials(m.name)}
                </div>
                <span className="text-sm font-medium">{m.name}</span>
              </button>
            )
          })}
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

      {showInvoice && (
        <div className="mt-8 mb-4 border-t border-rule pt-6">
          <div className="flex justify-between items-center mb-4">
             <h6 className="font-display font-medium text-lg">Live Receipt Preview</h6>
             <button onClick={downloadReceipt} className="text-xs font-bold uppercase tracking-wider text-accent hover:text-accent-soft transition-colors flex items-center gap-1">
               Download PNG
             </button>
          </div>
          <div className="w-full max-w-[26rem] mx-auto text-[#111] font-mono text-[0.9rem] leading-relaxed relative drop-shadow-2xl" ref={receiptRef}>
            <div className="h-2 w-full" style={{ background: 'radial-gradient(circle at 50% 0, transparent 4px, #fdfbf7 4.5px)', backgroundSize: '10px 10px', backgroundRepeat: 'repeat-x' }}></div>
            
            <div className="bg-[#fdfbf7] px-6 sm:px-8 pt-8 pb-4">
              <div className="border-b-2 border-dashed border-[#ccc] pb-6 text-center">
                <h3 className="text-xl font-bold tracking-[0.15em] uppercase">{tripName || 'Trip'} Receipt</h3>
                <p className="mt-1 text-xs uppercase tracking-[0.1em] text-[#555]">{title || 'Untitled Expense'}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.1em] text-[#555]">{new Date().toLocaleDateString()}</p>
              </div>

              <div className="divide-y-2 divide-dashed divide-[#ccc]">
                {selected.map(id => {
                  const m = members.find(x => x.id === id);
                  if (!m) return null;
                  let amt = 0;
                  if (method === 'equal') amt = Number(total) / selected.length || 0;
                  else amt = Number(customSplits[id]) || 0;

                  return (
                    <div key={id} className="py-6">
                      <div className="font-bold uppercase text-[0.8rem] mb-3 text-[#111]">
                        {m.name}
                      </div>
                      <div className="mt-5 relative z-10 max-w-[90%] ml-auto">
                        <div className="absolute inset-0 bg-[#fef08a] transform -skew-x-12 -rotate-2 rounded-sm opacity-60"></div>
                        <div className="relative px-3 py-2 font-sans text-xs text-[#b91c1c] font-medium flex justify-between items-end">
                           <span className="flex flex-col">
                             <span className="uppercase tracking-wider text-[#991b1b] text-[10px] mb-0.5">Owes</span>
                           </span>
                           <span className="text-lg font-bold tracking-tight">₹{amt.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border-t-2 border-dashed border-[#ccc] pt-6">
                <div className="flex items-end justify-between font-bold border-t-2 border-[#111] pt-3 mt-1">
                  <span className="text-lg uppercase">Total</span>
                  <span className="text-2xl tracking-tighter">₹{Number(total || 0).toFixed(2)}</span>
                </div>
                <div className="mt-8 text-center text-[#555] text-[10px] uppercase space-y-1 opacity-80 font-sans tracking-wide pb-4">
                  <p>TO THE BEST TRIP EVER ❤️</p>
                  <p className="mt-2 font-bold text-[#111] text-xs">Thank you!</p>
                </div>
              </div>
            </div>
            <div className="h-2 w-full" style={{ background: 'radial-gradient(circle at 50% 100%, transparent 4px, #fdfbf7 4.5px)', backgroundSize: '10px 10px', backgroundRepeat: 'repeat-x' }}></div>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-between items-center gap-3 border-t border-rule pt-4">
        <label className="group flex items-center gap-2.5 text-sm font-medium text-ink cursor-pointer hover:text-ink-strong transition-colors bg-surface border border-rule-strong rounded-xl px-4 py-2 hover:bg-sunken hover:border-ink hover:shadow-sm">
          <div className="relative flex items-center">
            <input type="checkbox" checked={showInvoice} onChange={(e) => setShowInvoice(e.target.checked)} className="peer sr-only" />
            <div className="w-5 h-5 border-2 border-rule-strong rounded-[6px] bg-surface peer-checked:bg-ink peer-checked:border-ink transition-all"></div>
            <svg className="absolute inset-0 w-5 h-5 text-canvas opacity-0 peer-checked:opacity-100 scale-50 peer-checked:scale-100 transition-all duration-200 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </div>
          Preview Live Receipt
        </label>
        
        <div className="flex gap-3">
          {onCancel ? (
            <button
              className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-sunken" 
              onClick={onCancel}
            >
              Cancel
            </button>
          ) : (
            <button
              className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-sunken" 
              onClick={() => { 
                setTitle(''); 
                setTotal(''); 
                setMethod('equal'); 
                setCustomSplits({}); 
                setCategory('');
                setSplitPayment(false);
                setPayerAmounts({});
                setSelected(members.map((m: Member) => m.id));
                setPayerId(members[0]?.id || '');
                setErrors({}); 
                setShowInvoice(false);
              }}
            >
              Reset
            </button>
          )}
          <button className="inline-flex min-h-[2.75rem] items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-ink/88 shadow-md" onClick={submit}>
            {editingExpense ? 'Update expense' : 'Add expense'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExpenseList({ expenses, members, onDelete, onEdit }: ExpenseListProps) {
  const nameOf = (id: string): string => members.find((m: Member) => m.id === id)?.name || 'Unknown';
  return (
    <div className="rounded-2xl border border-rule bg-surface p-5">
      <h2 className="font-display text-xl tracking-tight">Expenses</h2>
      {expenses.length === 0 ? (
        <p className="mt-2 text-sm text-ink-subtle">No expenses yet.</p>
      ) : (
        // Rows separated by rules rather than boxed individually: a list of
        // ringed cards inside a card is three nested containers deep.
        <ul className="mt-2 divide-y divide-rule overflow-hidden">
          <AnimatePresence initial={false}>
          {expenses.map((e: Expense) => {
            const share = isEqualSplit(e) && e.splits.length > 1
              ? `split ${e.splits.length} ways · ₹${currency(e.splits[0].amount)} each`
              : `${e.splits.length} custom share${e.splits.length === 1 ? '' : 's'}`;
            return (
              <motion.li 
                key={e.id} 
                initial={{ opacity: 0, y: -20, rotateX: 45 }}
                animate={{ opacity: 1, y: 0, rotateX: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                className="group flex items-center gap-3 py-3"
              >
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
                    {e.category === 'settlement' && e.splits.length === 1 ? (
                      `${payersOf(e).map((pay: Split) => nameOf(pay.memberId)).join(' and ')} paid ${nameOf(e.splits[0].memberId)}`
                    ) : (
                      `${payersOf(e).map((pay: Split) => nameOf(pay.memberId)).join(' and ')} paid · ${share}`
                    )}
                  </div>
                </div>

                <div className="shrink-0 text-right mr-2">
                  <div className="font-semibold tnum">₹{currency(e.total)}</div>
                  <div className="text-xs text-ink-subtle">
                    {new Date(e.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </div>
                </div>

                <div className="flex shrink-0">
                  <button
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-subtle transition-opacity hover:bg-sunken hover:text-ink sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
                    onClick={() => onEdit(e)}
                    aria-label={`Edit ${e.title}`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-4 w-4">
                      <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
                        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
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
                </div>
              </motion.li>
            );
          })}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}

function SummaryPanel({ trip, onSettle }: SummaryPanelProps) {
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
    const ops: { from: string; fromId: string; to: string; toId: string; amount: number }[] = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const d = debtors[i];
      const c = creditors[j];
      const amt = Math.min(d.need, c.can);
      // Round numerically rather than parsing currency()'s formatted output,
      // that string carries digit grouping and would parse back as NaN.
      ops.push({ from: d.name, fromId: d.id, to: c.name, toId: c.id, amount: Math.round(amt * 100) / 100 });
      d.need -= amt; c.can -= amt;
      if (d.need <= 0.005) i++;
      if (c.can <= 0.005) j++;
    }
    return ops;
  }

  const settle = settlements();
  const totalTrip = trip.expenses.reduce((s: number, e: Expense) => s + Number(e.total), 0);
  const involvedCount = trip.members.filter(m => (totalsByMemberPaid[m.id] || 0) > 0 || (totalsByMemberOwed[m.id] || 0) > 0).length;
  const perHead = involvedCount ? totalTrip / involvedCount : 0;

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
            {onSettle && (
              <button 
                onClick={() => onSettle(settle)}
                className="mt-4 w-full inline-flex min-h-[2.75rem] items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-ink/88"
              >
                Settle all dues
              </button>
            )}
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

// Matches TripCard's geometry so the list does not jump when real data lands.
function TripCardSkeleton() {
  return (
    <div data-testid="trip-skeleton" aria-hidden className="rounded-2xl border border-rule bg-surface p-5">
      <div className="flex justify-between items-start">
        <div className="space-y-2">
          <div className="h-5 w-32 animate-pulse rounded bg-sunken" />
          <div className="h-4 w-40 animate-pulse rounded bg-sunken" />
        </div>
        <div className="space-y-2 text-right">
          <div className="ml-auto h-4 w-10 animate-pulse rounded bg-sunken" />
          <div className="ml-auto h-5 w-20 animate-pulse rounded bg-sunken" />
        </div>
      </div>
      <div className="mt-4 h-11 animate-pulse rounded-full bg-sunken" />
    </div>
  );
}

// A failed pull must never render as "you have no trips". Saying so would
// invite a duplicate that then syncs and pollutes the account.
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-rule bg-surface p-8 text-center">
      <h2 className="font-display text-xl tracking-tight">Couldn't load your trips</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
        Anything saved in this browser is still here and still safe. This is only about
        reaching your account.
      </p>
      <button
        onClick={onRetry}
        className="mt-4 inline-flex min-h-[2.75rem] items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-ink/88"
      >
        Try again
      </button>
    </div>
  );
}

// Shown once, and only after the pull has settled: offering to upload trips
// before we know what is already up there risks duplicating them.
function AdoptPrompt({ count, onAdopt, onDismiss }: {
  count: number;
  onAdopt: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 id="adopt-title" className="font-display text-xl tracking-tight">
          Bring your {count} trip{count === 1 ? '' : 's'} into this account?
        </h3>
        <p className="mt-1 text-sm text-ink-muted">
          {count === 1 ? 'It was' : 'They were'} saved in this browser before you signed in.
          Adding {count === 1 ? 'it' : 'them'} means {count === 1 ? 'it follows' : 'they follow'} you
          to your other devices. Saying no leaves {count === 1 ? 'it' : 'them'} here, untouched.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onDismiss}
          className="rounded-full border border-rule-strong px-4 py-2 text-sm font-medium transition-colors hover:bg-sunken"
        >
          Leave them here
        </button>
        <button
          onClick={onAdopt}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-ink/88"
        >
          Bring them in
        </button>
      </div>
    </div>
  );
}

export default function TripExpenseApp() {
  const { user } = useSession();
  const [trips, setTrips] = useLocalState<Trip[]>(tripsKey(user?.id ?? null), []);
  // Trips saved before uuids existed cannot be written to Postgres, and the
  // rewrite has to happen before anything is pushed. Idempotent, so running
  // it on every mount costs one array scan once the work is done.
  useEffect(() => {
    setTrips((prev: Trip[]) => migrateLegacyIds(prev));
  }, [setTrips]);
  // The URL is the source of truth for which surface is showing, so back,
  // forward, refresh and a shared link all land in the same place.
  const [route, navigate] = useRoute();
  const seenLanding = route.name !== 'landing';
  const openTripId = route.name === 'trip' ? route.id : null;

  const [showNew, setShowNew] = useState<boolean>(false);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Member | null>(null);
  // SheetJS arrives in a lazy 139 kB chunk. On a slow connection the button
  // would sit silent for seconds and get clicked repeatedly.
  const [exportState, setExportState] = useState<'idle' | 'working' | 'failed'>('idle');
  const [theme, toggleTheme] = useTheme();
  // Phones only. On a wide screen every panel is visible at once, so the tabs
  // are hidden and the classes below fall back to lg:block.
  const [tab, setTab] = useState<'people' | 'expenses' | 'settle'>('expenses');
  const [signInReason, setSignInReason] = useState<string | null>(null);
  // Only offered once per account, so a decline stays declined.
  const [adoptAsked, setAdoptAsked] = useLocalState<Record<string, boolean>>('hisaab_adopt_asked', {});
  const [orphans, setOrphans] = useState<Trip[] | null>(null);
  
  const [showLoader, setShowLoader] = useState<boolean>(seenLanding);

  useEffect(() => {
    if (showLoader && seenLanding) {
      const t = setTimeout(() => setShowLoader(false), 1800);
      return () => clearTimeout(t);
    }
  }, [showLoader, seenLanding]);

  const sync = useSync(user?.id ?? null, trips, setTrips);

  // Every mutation stamps the trip and marks it dirty. The push itself is a
  // background consequence, never a step the user waits on.
  const stampNow = (t: Trip): Trip => ({ ...t, updatedAt: new Date().toISOString() });

  const createTrip = (t: Trip) => {
    setTrips((prev: Trip[]) => [stampNow(t), ...prev]);
    sync.markDirty(t.id);
  };
  const deleteTrip = (id: string) => {
    setTrips((prev: Trip[]) => prev.filter((t: Trip) => t.id !== id));
    sync.markDeleted(id);
  };

  const openTrip = (id: string) => navigate({ name: 'trip', id });
  const closeTrip = () => { navigate({ name: 'trips' }); setEditingExpenseId(null); };

  const updateTrip = (updated: Trip) => {
    setTrips((prev: Trip[]) => prev.map((t: Trip) => t.id === updated.id ? stampNow(updated) : t));
    sync.markDirty(updated.id);
  };

  const current = trips.find((t: Trip) => t.id === openTripId);

  // A trip id in the URL that resolves to nothing: a deleted trip, or a link
  // from someone else's account. Send them to the list rather than showing it
  // while the address bar claims otherwise. Waits for the first pull, or a
  // legitimate deep link would bounce before the cloud copy arrived, and
  // replaces rather than pushes so Back does not land on the dead URL again.
  useEffect(() => {
    if (route.name !== 'trip' || !sync.hydrated) return;
    if (trips.some((t: Trip) => t.id === route.id)) return;
    navigate({ name: 'trips' }, true);
  }, [route, trips, sync.hydrated, navigate]);
  const activeMembers = current ? current.members.filter(isActive) : [];

  const confirmRemoval = (mode: RemovalMode) => {
    if (current && pendingRemoval) updateTrip(applyRemoval(current, pendingRemoval.id, mode));
    setPendingRemoval(null);
  };

  // Offer to adopt anonymous trips, but only once the pull has settled. The
  // anonymous store is never modified, so declining costs nothing.
  useEffect(() => {
    const me = user?.id;
    if (!me || !sync.hydrated || sync.pullFailed) return;
    if (adoptAsked[me]) return;
    try {
      const raw = localStorage.getItem(tripsKey(null));
      const local: Trip[] = raw ? JSON.parse(raw) : [];
      if (local.length > 0) setOrphans(local);
      else setAdoptAsked((prev) => ({ ...prev, [me]: true }));
    } catch (e) {
      setAdoptAsked((prev) => ({ ...prev, [me]: true }));
    }
  }, [user?.id, sync.hydrated, sync.pullFailed, adoptAsked, setAdoptAsked]);

  const adoptOrphans = () => {
    const me = user?.id;
    if (!orphans || !me) return;
    // Ids are already uuids and unique, so this is a plain union. The
    // anonymous store is left exactly as it was: nothing is deleted, so
    // signing out reveals it again intact.
    const mine = new Set(trips.map((t: Trip) => t.id));
    const incoming = migrateLegacyIds(orphans).filter((t: Trip) => !mine.has(t.id));
    setTrips((prev: Trip[]) => [...incoming, ...prev]);
    incoming.forEach((t: Trip) => sync.markDirty(t.id));
    setAdoptAsked((prev) => ({ ...prev, [me]: true }));
    setOrphans(null);
  };

  const declineOrphans = () => {
    const me = user?.id;
    if (me) setAdoptAsked((prev) => ({ ...prev, [me]: true }));
    setOrphans(null);
  };

  // Wiping every trip is unrecoverable, so name what is about to be lost.
  const resetAllData = () => {
    const n = trips.length;
    const expenseCount = trips.reduce((s: number, t: Trip) => s + t.expenses.length, 0);
    const ok = window.confirm(
      `Delete all ${n} trip${n === 1 ? '' : 's'} and ${expenseCount} expense${expenseCount === 1 ? '' : 's'}?\n\n` +
      'This cannot be undone. Export to CSV first if you want a copy.'
    );
    if (!ok) return;
    trips.forEach((t: Trip) => sync.markDeleted(t.id));
    setTrips([]);
  };

  // Crossing between the landing and the app kept the window's scroll offset,
  // so leaving from halfway down the landing dropped you halfway down the app.
  // That is what made the change feel like a different page appearing behind
  // this one. Reset on every crossing, in both directions.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [seenLanding]);

  if (!seenLanding) {
    return (
      <>
        <Landing
          theme={theme}
          onToggleTheme={toggleTheme}
          signedIn={!!user}
          onSignIn={() => setSignInReason('Keep your trips across devices.')}
          onStart={() => { navigate({ name: 'trips' }); setShowLoader(true); }}
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
    <>
      <AnimatePresence>
        {showLoader && <LoadingScreen />}
      </AnimatePresence>
      <div className="app-enter min-h-screen bg-canvas p-6 font-sans relative overflow-hidden">
        {/* Ledger Background Pattern */}
        <div className="fixed inset-0 z-0 opacity-[0.25] pointer-events-none" aria-hidden>
          <div className="h-full w-full" style={{ backgroundImage: 'linear-gradient(to bottom, rgb(var(--rule)) 1px, transparent 1px)', backgroundSize: '100% 40px' }} />
          <div className="absolute top-0 left-[8%] sm:left-[12%] h-full w-[1px] bg-debit/20" />
        </div>

        <div className="max-w-6xl mx-auto relative z-10">
          <header className="flex flex-wrap items-center justify-between gap-4 mb-8 pt-4">
            <div>
              <h1 className="font-display font-black tracking-tighter text-[2.5rem] sm:text-[3rem] text-ink">
                <button
                  type="button"
                  onClick={() => navigate({ name: 'landing' })}
                  title="Back to the Hisaab home page"
                  className="transition-transform hover:scale-105 active:scale-95 duration-300 text-inherit origin-left flex items-center"
                >
                  <span className="text-ink hover:text-accent transition-colors duration-300">
                    Hisaab
                  </span>
                </button>
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-3 sm:gap-4 bg-surface sm:bg-transparent border sm:border-0 border-rule rounded-full sm:rounded-none px-4 sm:px-0 py-1.5 sm:py-0 shadow-sm sm:shadow-none">
              <SyncStatus
                phase={sync.phase}
                onRetry={sync.retry}
                onSignIn={() => setSignInReason('Sign in again to keep syncing.')}
              />
              <div className="w-px h-5 bg-rule hidden sm:block"></div>
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
              {isBackendConfigured && (
                user ? (
                  <button
                    onClick={() => signOut()}
                    title={user.email || 'Signed in'}
                    className="inline-flex min-h-[2.25rem] items-center rounded-full px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
                  >
                    Sign out
                  </button>
                ) : (
                  <button
                    onClick={() => setSignInReason('')}
                    className="group relative inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
                    title="Sign in to back up your data"
                  >
                    <svg className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 11v6m0 0l-3-3m3 3l3-3" /></svg>
                    <span>Sign in <span className="hidden sm:inline-block font-normal opacity-70">to sync</span></span>
                  </button>
                )
              )}
              {/* Destructive and irreversible, so it stays out of reach of the
                  primary action and only appears when there is data to lose. */}
              {!current && trips.length > 0 && (
                <button
                  className="rounded-full px-3 py-2 min-h-[2.25rem] text-sm font-medium text-ink-muted transition-colors hover:bg-debit-soft hover:text-debit"
                  onClick={resetAllData}
                >
                  Reset data
                </button>
              )}
              <button
                className="inline-flex min-h-[2.25rem] ml-1 items-center justify-center rounded-full bg-ink px-4 py-2 text-sm font-medium text-canvas transition-colors hover:bg-ink/88"
                onClick={() => setShowNew(true)}
              >
                New trip
              </button>
            </div>
          </header>

        {!current && trips.length === 0 && sync.skeleton && (
          <main>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <TripCardSkeleton />
              <TripCardSkeleton />
              <TripCardSkeleton />
            </div>
          </main>
        )}

        {!current && trips.length === 0 && !sync.skeleton && sync.hydrated && sync.pullFailed && (
          <main>
            <LoadFailed onRetry={sync.retry} />
          </main>
        )}

        {/* hydrated is required, not implied by the two flags above. For the
            first 200ms of a pull the skeleton is deliberately suppressed, and
            without this guard that window would render EmptyState, telling
            someone with cloud trips that they have none, which invites a
            duplicate. Rendering nothing briefly is the honest answer when the
            answer is not yet known. */}
        {!current && trips.length === 0 && !sync.skeleton && !sync.pullFailed && sync.hydrated && (
          <main>
            <EmptyState 
              onCreate={() => setShowNew(true)} 
              onReadGuide={() => navigate({ name: 'landing' })}
            />
          </main>
        )}

        {!current && trips.length > 0 && (
          // Trip cards sit on the canvas rather than inside a panel: a card
          // holding cards is a container standing in for a heading.
          <main>
            <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-rule pb-4">
              <h2 className="font-display text-3xl tracking-tight text-ink">Your trips</h2>
              <p className="text-base font-medium text-ink-muted tnum">
                {trips.length} trip{trips.length === 1 ? '' : 's'} · ₹{currency(trips.reduce((s: number, t: Trip) => s + t.expenses.reduce((ss: number, e: Expense) => ss + Number(e.total), 0), 0))} logged
              </p>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
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

            {/* One job per screen on a phone. Desktop still shows the lot. */}
            <div className="flex gap-1 rounded-full border border-rule bg-surface p-1 lg:hidden">
              {([
                ['people', 'People', activeMembers.length],
                ['expenses', 'Expenses', current.expenses.length],
                ['settle', 'Settle up', null],
              ] as const).map(([key, label, count]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  aria-current={tab === key ? 'page' : undefined}
                  className={`flex min-h-[2.75rem] flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-sm font-medium transition-colors ${
                    tab === key ? 'bg-ink text-canvas' : 'text-ink-muted hover:bg-sunken'
                  }`}
                >
                  {label}
                  {count !== null && count > 0 && (
                    <span className={`tnum text-xs ${tab === key ? 'text-canvas/70' : 'text-ink-subtle'}`}>
                      {count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-2 lg:contents">
              <div className={`space-y-4 lg:col-span-2 lg:col-start-1 lg:row-start-1 ${tab === 'people' ? '' : 'hidden'} lg:block`}>
                <MemberList
                  members={activeMembers}
                  addMember={(m: Member) => {
                    const upd = { ...current, members: [...current.members, m] };
                    updateTrip(upd);
                  }}
                  onRequestRemove={(m: Member) => {
                    const impact = removalImpact(current, m.id);
                    if (impact.involvedCount === 0 && impact.paidCount === 0) {
                      updateTrip(applyRemoval(current, m.id, 'keep'));
                    } else {
                      setPendingRemoval(m);
                    }
                  }}
                />
              </div>

              <div className={`space-y-4 lg:col-span-2 lg:col-start-1 lg:row-start-2 ${tab === 'expenses' ? '' : 'hidden'} lg:block`}>
                <ExpenseForm 
                  members={activeMembers}
                  existingCategories={Array.from(new Set(current.expenses.map((e: Expense) => e.category)))}
                  tripName={current.name}
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
                  onEdit={(exp: Expense) => setEditingExpenseId(exp.id)}
                />
              </div>

              </div>

              <div className={`space-y-4 lg:col-start-3 lg:row-start-1 lg:row-end-3 ${tab === 'settle' ? '' : 'hidden'} lg:block`}>
                <SummaryPanel trip={current} onSettle={(settlements) => {
                  const newExpenses = settlements.map(s => ({
                    id: newId(),
                    title: 'Settled dues',
                    payerId: s.fromId,
                    total: s.amount,
                    splits: [{ memberId: s.toId, amount: s.amount }],
                    category: 'settlement',
                    date: new Date().toISOString()
                  }));
                  updateTrip({ ...current, expenses: [...current.expenses, ...newExpenses] });
                  setTab('expenses');
                }} />
                <div className="rounded-2xl border border-rule bg-surface p-5">
                  <h2 className="font-display text-xl tracking-tight mb-3">Actions</h2>
<div className="flex gap-3">
  <button 
    className="flex-1 inline-flex min-h-[3.5rem] items-center justify-center gap-2 rounded-xl border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-all hover:bg-sunken hover:border-accent hover:shadow-sm" 
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
    <svg className="w-5 h-5 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
    Export CSV
  </button>
  <button 
    className="flex-1 inline-flex min-h-[3.5rem] items-center justify-center gap-2 rounded-xl border border-rule-strong px-4 py-2.5 text-sm font-medium text-ink transition-all hover:bg-sunken hover:border-accent hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
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
    <svg className="w-5 h-5 text-ink-muted group-hover:text-ink transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
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

      {showNew && <NewTripModal onClose={() => setShowNew(false)} onCreate={(t: Trip) => {
        createTrip(t);
        openTrip(t.id);
        setTab('people');
      }} />}
      {signInReason !== null && (
        <Modal onClose={() => setSignInReason(null)} labelledBy="signin-title" width="max-w-md">
          <SignIn
            reason={signInReason || undefined}
            onClose={() => setSignInReason(null)}
            onSignedIn={() => setSignInReason(null)}
          />
        </Modal>
      )}
      {orphans && orphans.length > 0 && (
        <Modal onClose={declineOrphans} labelledBy="adopt-title" width="max-w-md">
          <AdoptPrompt count={orphans.length} onAdopt={adoptOrphans} onDismiss={declineOrphans} />
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
      {editingExpenseId && current && (
        <Modal onClose={() => setEditingExpenseId(null)} labelledBy="edit-expense-title" width="max-w-lg">
          <h2 id="edit-expense-title" className="sr-only">Edit Expense</h2>
          <div className="-mx-2 sm:-mx-4">
            <ExpenseForm
              members={activeMembers}
              existingCategories={Array.from(new Set(current.expenses.map((e: Expense) => e.category)))}
              editingExpense={current.expenses.find((e: Expense) => e.id === editingExpenseId)}
              tripName={current.name}
              onAdd={() => {}}
              onUpdate={(exp: Expense) => {
                const upd = { ...current, expenses: current.expenses.map((e: Expense) => e.id === exp.id ? exp : e) };
                updateTrip(upd);
                setEditingExpenseId(null);
              }}
              onCancel={() => setEditingExpenseId(null)}
            />
          </div>
        </Modal>
      )}
    </div>
    </>
  );
}