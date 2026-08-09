-- Hisaab, invariants the database enforces for itself.
--
-- Row level security answers "may I touch this row?". It never answers "is
-- this row sane?". Everything below is the second question: shapes the app
-- would never produce, but a REST client could, and which would leave the
-- ledger quietly wrong.

-- ------------------------------------------------------------ ordering ----
-- Expenses render in insertion order and nothing sorts them, so spent_at is
-- not the display order. Reading back ordered by spent_at would reshuffle
-- every list on a new device. Members already had this column.
alter table public.expenses
  add column if not exists position integer not null default 0;

-- -------------------------------------------------------------- limits ----
-- numeric(12,2) permits 9,999,999,999.99. A ceiling makes an absurd amount a
-- rejection rather than a number nobody notices until settlement.
alter table public.expenses drop constraint if exists expenses_total_check;
alter table public.expenses
  add constraint expenses_total_check check (total > 0 and total <= 10000000);

alter table public.splits drop constraint if exists splits_amount_check;
alter table public.splits
  add constraint splits_amount_check check (amount > 0 and amount <= 10000000);

-- ------------------------------------------------- same-trip integrity ----
-- A split could name a member of a different trip: splits.member_id
-- referenced members(id) with nothing tying it to the expense's trip. The fix
-- is structural rather than a trigger. Carrying trip_id on the child and
-- pointing a composite key at (id, trip_id) makes the wrong row unreferenceable.
alter table public.members
  add constraint members_id_trip_key unique (id, trip_id);
alter table public.expenses
  add constraint expenses_id_trip_key unique (id, trip_id);

alter table public.splits
  add column if not exists trip_id uuid;
update public.splits s
   set trip_id = e.trip_id
  from public.expenses e
 where e.id = s.expense_id and s.trip_id is null;
alter table public.splits
  alter column trip_id set not null;

-- Replace the single-column references with composite ones.
alter table public.expenses drop constraint if exists expenses_payer_id_fkey;
alter table public.expenses
  add constraint expenses_payer_in_trip
  foreign key (payer_id, trip_id) references public.members (id, trip_id)
  on delete restrict;

alter table public.splits drop constraint if exists splits_expense_id_fkey;
alter table public.splits
  add constraint splits_expense_in_trip
  foreign key (expense_id, trip_id) references public.expenses (id, trip_id)
  on delete cascade;

alter table public.splits drop constraint if exists splits_member_id_fkey;
alter table public.splits
  add constraint splits_member_in_trip
  foreign key (member_id, trip_id) references public.members (id, trip_id)
  on delete restrict;

-- ------------------------------------------------------------ payments ----
-- Where Expense.payers lives. The schema predated split payments, so
-- expenses.payer_id was the only place a payer could be recorded.
--
-- expenses.payer_id keeps its meaning: the canonical single payer, and the
-- first payer when several paid. Rows here exist only when more than one
-- person put money in. That mirrors the client model exactly, which is what
-- makes the row translation lossless and therefore testable.
create table if not exists public.payments (
  id         uuid primary key default gen_random_uuid(),
  expense_id uuid not null,
  trip_id    uuid not null,
  member_id  uuid not null,
  amount     numeric(12,2) not null check (amount > 0 and amount <= 10000000),
  unique (expense_id, member_id),
  constraint payments_expense_in_trip
    foreign key (expense_id, trip_id) references public.expenses (id, trip_id)
    on delete cascade,
  constraint payments_member_in_trip
    foreign key (member_id, trip_id) references public.members (id, trip_id)
    on delete restrict
);
create index if not exists payments_expense_idx on public.payments (expense_id);
create index if not exists splits_trip_idx on public.splits (trip_id);
create index if not exists payments_trip_idx on public.payments (trip_id);

alter table public.payments enable row level security;

drop policy if exists payments_via_expense on public.payments;
create policy payments_via_expense on public.payments
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

-- ------------------------------------------------------- balance check ----
-- The one invariant that cannot be a column constraint, because it spans
-- rows: what everyone owes must equal what the expense cost. Deferred to
-- commit, so a whole trip can be written in any order inside one transaction.
create or replace function public.check_expense_balanced() returns trigger
language plpgsql as $$
declare
  eid     uuid;
  e_total numeric(12,2);
  s_total numeric(12,2);
  p_total numeric(12,2);
  p_count integer;
begin
  if tg_table_name = 'expenses' then
    if tg_op = 'DELETE' then eid := old.id; else eid := new.id; end if;
  else
    if tg_op = 'DELETE' then eid := old.expense_id; else eid := new.expense_id; end if;
  end if;

  select total into e_total from public.expenses where id = eid;
  -- The parent is gone, so this fired from the cascade that removed it.
  -- Without this the check would evaluate against a vanished row and make
  -- deleting any expense impossible.
  if not found then
    return null;
  end if;

  select coalesce(sum(amount), 0) into s_total
    from public.splits where expense_id = eid;
  if abs(s_total - e_total) > 0.005 then
    raise exception 'splits for expense % sum to %, but the total is %',
      eid, s_total, e_total;
  end if;

  select coalesce(sum(amount), 0), count(*) into p_total, p_count
    from public.payments where expense_id = eid;
  if p_count > 0 and abs(p_total - e_total) > 0.005 then
    raise exception 'payments for expense % sum to %, but the total is %',
      eid, p_total, e_total;
  end if;

  return null;
end;
$$;

drop trigger if exists splits_balanced on public.splits;
create constraint trigger splits_balanced
  after insert or update or delete on public.splits
  deferrable initially deferred
  for each row execute function public.check_expense_balanced();

drop trigger if exists payments_balanced on public.payments;
create constraint trigger payments_balanced
  after insert or update or delete on public.payments
  deferrable initially deferred
  for each row execute function public.check_expense_balanced();

drop trigger if exists expenses_balanced on public.expenses;
create constraint trigger expenses_balanced
  after insert or update on public.expenses
  deferrable initially deferred
  for each row execute function public.check_expense_balanced();

-- --------------------------------------------------------------- owner ----
-- owner was client-supplied. The RLS with-check stopped impersonation on
-- insert but nothing stopped a later reassignment.
alter table public.trips alter column owner set default auth.uid();

create or replace function public.freeze_trip_owner() returns trigger
language plpgsql as $$
begin
  if new.owner is distinct from old.owner then
    raise exception 'a trip cannot change owner';
  end if;
  return new;
end;
$$;

drop trigger if exists trips_owner_frozen on public.trips;
create trigger trips_owner_frozen before update on public.trips
  for each row execute function public.freeze_trip_owner();

-- ---------------------------------------------------------- row limits ----
-- Nothing stopped a client filling the table. These are deliberately far
-- above any real trip.
create or replace function public.cap_trips() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.trips where owner = new.owner) >= 200 then
    raise exception 'a single account is limited to 200 trips';
  end if;
  return new;
end;
$$;

create or replace function public.cap_members() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.members where trip_id = new.trip_id) >= 100 then
    raise exception 'a single trip is limited to 100 members';
  end if;
  return new;
end;
$$;

create or replace function public.cap_expenses() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.expenses where trip_id = new.trip_id) >= 5000 then
    raise exception 'a single trip is limited to 5000 expenses';
  end if;
  return new;
end;
$$;

drop trigger if exists trips_capped on public.trips;
create trigger trips_capped before insert on public.trips
  for each row execute function public.cap_trips();

drop trigger if exists members_capped on public.members;
create trigger members_capped before insert on public.members
  for each row execute function public.cap_members();

drop trigger if exists expenses_capped on public.expenses;
create trigger expenses_capped before insert on public.expenses
  for each row execute function public.cap_expenses();
