# Hisaab — shared trips

Design, 2026-08-10.

## Problem

A trip has one owner. Everyone else in it is a text label. `trips_owner_all`
restricts every read and write to `owner = auth.uid()`, and `members` has no
link to `auth.users`. So a group cannot log its own expenses; one person types
everything.

The goal: any number of people, each with their own account, adding and editing
entries in one trip.

## Decisions

| Question | Decision |
|---|---|
| Identity | A joiner **claims** an existing member, or creates one. `members.user_id`. |
| Invite | One short code per trip, usable as a link or read aloud. |
| Permissions | Everyone edits everything. Owner alone deletes the trip, resets the code, removes people. |
| Scale | Any N. Nothing in the model is pairwise. |

## Why this is two phases

Phase A has no user-visible effect and must ship first. `save_trip` writes a
whole trip: it deletes and reinserts every split, and deletes any expense not
in the payload. With one writer that is correct. With two it is a bulldozer —
the second save erases the first person's expense.

Phase B is the feature and depends on A being in place.

---

## Phase A — per-entity sync

### Write granularity

The unit of write becomes the expense, not the trip.

| New RPC | Replaces |
|---|---|
| `save_expense(trip_id uuid, expense jsonb)` | part of `save_trip` |
| `save_member(trip_id uuid, member jsonb)` | part of `save_trip` |
| `save_trip_meta(trip_id uuid, name text)` | part of `save_trip` |
| `delete_expense(id uuid)` | the orphan sweep |
| `delete_member(id uuid)` | the orphan sweep |

`save_trip` is dropped once nothing calls it. Splits and payments stay
delete-and-reinsert **within one expense**, which is safe: they are a set with
no identity of their own, and the deferred balance triggers still evaluate at
commit.

Two people adding different expenses no longer collide. Two people editing the
same expense still resolve last-write-wins, but the loss is one expense rather
than the trip.

### Deletes become tombstones

This is the part that is not optional.

Today, "absent from the payload" means "deleted". With a second writer that
inference is wrong: an expense missing from your copy may be one somebody else
added a minute ago and you have not pulled. Pushing would delete their work.

There is no way to distinguish *I deleted this* from *I have not seen this yet*
without recording the deletion. So:

- `expenses.deleted_at timestamptz` and `members.deleted_at timestamptz`.
- Deleting writes a timestamp; it does not remove the row.
- The client filters deleted rows out on read.
- `members.active` is unchanged and still means retired-but-present. Retirement
  and deletion are different things and both are needed.

### Reconciliation

`reconcile` moves from merging trips to merging entities. Each expense and
member carries its own server `updated_at`, maintained by a touch trigger, and
merges independently by the same rules already tested: newer stamp wins, local
wins while dirty, tombstone outranks both.

The dirty set is keyed `expense:<id>` and `member:<id>` rather than by trip.

### What does not change

`allocateEqually`, the settlement algorithm, `rows.ts` translation, and the
money invariants in `0002_sync.sql`. All of it is already N-way and stays.

---

## Phase B — access, joining, identity

### Access

```sql
create table public.trip_access (
  trip_id   uuid not null references public.trips(id) on delete cascade,
  user_id   uuid not null references auth.users(id)  on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
```

`trips.owner` stays and continues to mean the creator.

Every RLS policy on all five tables moves from `owner = auth.uid()` to
`public.has_trip_access(trip_id)`:

```sql
create function public.has_trip_access(t uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.trips where id = t and owner = auth.uid())
      or exists (select 1 from public.trip_access
                  where trip_id = t and user_id = auth.uid());
$$;
```

`security definer` is required here, not stylistic: a policy on `trips` that
queried `trip_access` under the caller's own rights would re-enter RLS and
recurse.

### Joining

`trips` gains `join_code text unique` and `join_open boolean not null default
true`. The code is 8 characters from an alphabet excluding `O 0 I 1`, so it
survives being read aloud. 32^8 is about 10^12, which is not brute-forceable at
any sane request rate.

`join_trip(code text) returns uuid` — `security definer`, pinned search path.
Finds an open trip by code, inserts a `trip_access` row for `auth.uid()`,
returns the trip id. Idempotent: joining twice is a no-op, not an error.

The link `/join/<code>` and a typed code call the same function. The code is a
bearer credential, so the owner can reset it and close joining once everyone is
in.

### Identity

`members.user_id uuid references auth.users(id)`, nullable, unique per trip.

`claim_member(trip_id uuid, member_id uuid) returns void` — sets `user_id` when
the caller has access, the member is unclaimed, and the caller has not already
claimed a member in that trip. Unclaimed members stay plain labels, so solo
trips are unaffected.

With a claim, the settle-up screen can say *you owe Rohan ₹471* instead of
making everyone find their own name in a table.

### Owner-only actions

Checked inside each RPC against `trips.owner`, not by RLS, because RLS now
grants access to everyone in the trip:

- `delete_trip`
- `reset_join_code(trip_id)`
- `revoke_access(trip_id, user_id)` — deletes the `trip_access` row and nulls
  that person's `members.user_id`, keeping the member row so the ledger keeps
  its history.

### Seeing each other's edits

A Supabase Realtime subscription scoped to the open trip, refetching that trip
on change. Without it, collaborators only see each other's work on reload,
which does not feel shared when five people are at one table.

---

## Out of scope

Roles beyond owner and editor. Per-person email invites. Presence indicators.
Comments. Real conflict resolution beyond last-write-wins per entity. Merging
two members into one.

## Risks

1. **Last-write-wins still loses data when two people edit the same expense.**
   Narrowed from a whole trip to one expense, not eliminated. Acceptable: the
   common case is different people adding different expenses.
2. **The join code is a bearer credential.** Anyone it is forwarded to can join.
   Mitigated by reset and by closing joining, not prevented.
3. **The RLS rewrite touches every policy.** A mistake exposes other people's
   trips. `supabase/tests/hostile.sql` gains cases for a non-member reading and
   writing a trip, and must be run before this ships.
4. **`save_trip` is removed.** Any client still calling it breaks. Phase A must
   land fully before Phase B.
