-- Hisaab, initial schema.
--
-- Run this once in the Supabase dashboard under SQL Editor.
--
-- Two things worth knowing before reading it:
--
--   1. Money is stored as numeric(12,2), never as a floating point number.
--      Floats cannot represent 0.10 exactly, and this app already went through
--      a round of bugs caused by rounding. numeric is exact decimal.
--
--   2. Every table has row level security switched on. That means the database
--      itself refuses to return a row unless the policy allows it. This is why
--      the anon key can be public: possessing it lets you ask, it does not let
--      you read anyone else's trips.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- trips ----
create table if not exists public.trips (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 120),
  created_at  timestamptz not null default now(),
  -- Last write wins. The client stamps this on every save; the newer stamp
  -- is the version that survives when the same trip was edited in two places.
  updated_at  timestamptz not null default now()
);
create index if not exists trips_owner_idx on public.trips (owner, updated_at desc);

-- -------------------------------------------------------------- members ----
create table if not exists public.members (
  id       uuid primary key default gen_random_uuid(),
  trip_id  uuid not null references public.trips(id) on delete cascade,
  name     text not null check (length(trim(name)) between 1 and 80),
  -- Members are retired, never deleted, so their past payments stay in the
  -- ledger. This mirrors the soft delete the app already does locally.
  active   boolean not null default true,
  position integer not null default 0
);
create index if not exists members_trip_idx on public.members (trip_id);

-- ------------------------------------------------------------- expenses ----
create table if not exists public.expenses (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  title      text not null check (length(trim(title)) between 1 and 160),
  payer_id   uuid not null references public.members(id) on delete restrict,
  total      numeric(12,2) not null check (total > 0),
  category   text not null default 'other',
  spent_at   timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists expenses_trip_idx on public.expenses (trip_id, spent_at desc);

-- --------------------------------------------------------------- splits ----
create table if not exists public.splits (
  id         uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  member_id  uuid not null references public.members(id) on delete restrict,
  amount     numeric(12,2) not null check (amount > 0),
  unique (expense_id, member_id)
);
create index if not exists splits_expense_idx on public.splits (expense_id);

-- ------------------------------------------------------------ security ----
alter table public.trips    enable row level security;
alter table public.members  enable row level security;
alter table public.expenses enable row level security;
alter table public.splits   enable row level security;

-- A trip is visible only to the person who owns it.
drop policy if exists trips_owner_all on public.trips;
create policy trips_owner_all on public.trips
  for all using (owner = auth.uid()) with check (owner = auth.uid());

-- Everything below a trip inherits that trip's ownership. Each policy asks
-- the same question: does the signed in user own the trip this row hangs off?
drop policy if exists members_via_trip on public.members;
create policy members_via_trip on public.members
  for all using (
    exists (select 1 from public.trips t where t.id = trip_id and t.owner = auth.uid())
  ) with check (
    exists (select 1 from public.trips t where t.id = trip_id and t.owner = auth.uid())
  );

drop policy if exists expenses_via_trip on public.expenses;
create policy expenses_via_trip on public.expenses
  for all using (
    exists (select 1 from public.trips t where t.id = trip_id and t.owner = auth.uid())
  ) with check (
    exists (select 1 from public.trips t where t.id = trip_id and t.owner = auth.uid())
  );

drop policy if exists splits_via_expense on public.splits;
create policy splits_via_expense on public.splits
  for all using (
    exists (
      select 1 from public.expenses e
      join public.trips t on t.id = e.trip_id
      where e.id = expense_id and t.owner = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.expenses e
      join public.trips t on t.id = e.trip_id
      where e.id = expense_id and t.owner = auth.uid()
    )
  );

-- Keep updated_at honest rather than trusting the client to set it.
create or replace function public.touch_trip() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trips_touch on public.trips;
create trigger trips_touch before update on public.trips
  for each row execute function public.touch_trip();
