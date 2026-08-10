-- Hisaab, per-entity sync.
--
-- Phase A of shared trips. Nothing here is visible to a user; it removes the
-- reason two people cannot edit one trip.
--
-- save_trip writes a whole trip: it deletes and reinserts every split, and
-- deletes any expense the payload does not contain. With one writer that is
-- correct. With two it is a bulldozer, because "absent from the payload" is
-- indistinguishable from "added by someone else since you last pulled".
--
-- So the write unit becomes the expense, and deletion becomes a tombstone
-- rather than an absence. save_trip is left in place and unused during the
-- changeover; a later migration drops it once no client calls it.

-- ------------------------------------------------------------ tombstones ----
-- A soft delete, distinct from members.active. `active` means retired but
-- still in the ledger; `deleted_at` means removed. Both are needed, and
-- conflating them would lose one of the two meanings.
alter table public.expenses add column if not exists deleted_at timestamptz;
alter table public.members  add column if not exists deleted_at timestamptz;

-- ---------------------------------------------------------- own stamps ----
-- Reconciliation moves from whole trips to single entities, so each entity
-- needs its own last-write mark rather than borrowing the trip's.
alter table public.expenses add column if not exists updated_at timestamptz not null default now();
alter table public.members  add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists expenses_touch on public.expenses;
create trigger expenses_touch before update on public.expenses
  for each row execute function public.touch_row();

drop trigger if exists members_touch on public.members;
create trigger members_touch before update on public.members
  for each row execute function public.touch_row();

create index if not exists expenses_updated_idx on public.expenses (trip_id, updated_at desc);
create index if not exists members_updated_idx  on public.members  (trip_id, updated_at desc);

-- ------------------------------------------------------------- helpers ----
-- Phase A keeps ownership as it is. Phase B replaces the body of this one
-- function with an access check, and every RPC below follows without edit.
create or replace function public.assert_trip_access(t uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  caller uuid := auth.uid();
  holder uuid;
begin
  if caller is null then
    raise exception 'not signed in';
  end if;
  select owner into holder from public.trips where id = t;
  if not found then
    raise exception 'no such trip';
  end if;
  if holder <> caller then
    raise exception 'that trip belongs to someone else';
  end if;
end;
$$;

-- ---------------------------------------------------------- trip meta ----
create or replace function public.save_trip_meta(trip_id uuid, name text, created_at timestamptz default null)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid    uuid := trip_id;
  caller uuid := auth.uid();
  stamp  timestamptz;
begin
  if caller is null then
    raise exception 'not signed in';
  end if;

  -- A trip that does not exist yet is this caller's to create; one that does
  -- must already be theirs. assert_trip_access raises on a missing trip, so
  -- the create path is handled here rather than there.
  if exists (select 1 from public.trips where id = tid) then
    perform public.assert_trip_access(tid);
    update public.trips set name = save_trip_meta.name where id = tid
      returning updated_at into stamp;
  else
    insert into public.trips (id, owner, name, created_at)
    values (tid, caller, save_trip_meta.name, coalesce(save_trip_meta.created_at, now()))
      returning updated_at into stamp;
  end if;

  return stamp;
end;
$$;

-- ------------------------------------------------------------- member ----
create or replace function public.save_member(trip_id uuid, member jsonb)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid   uuid := trip_id;
  stamp timestamptz;
begin
  perform public.assert_trip_access(tid);

  insert into public.members (id, trip_id, name, active, position, deleted_at)
  values (
    (member->>'id')::uuid, tid, member->>'name',
    coalesce((member->>'active')::boolean, true),
    coalesce((member->>'position')::int, 0),
    null
  )
  -- Arbitrated on (id, trip_id), not id alone: member ids are client-supplied
  -- and globally unique, so an id belonging to another trip must collide with
  -- the primary key and abort rather than quietly update that other trip's row.
  on conflict on constraint members_id_trip_key do update
     set name = excluded.name,
         active = excluded.active,
         position = excluded.position,
         deleted_at = null
  returning updated_at into stamp;

  return stamp;
end;
$$;

create or replace function public.delete_member(member_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid   uuid;
  stamp timestamptz;
begin
  select trip_id into tid from public.members where id = member_id;
  if not found then
    -- Already gone. Silent, so a retried tombstone settles instead of failing.
    return now();
  end if;
  perform public.assert_trip_access(tid);

  update public.members set deleted_at = now() where id = member_id
    returning updated_at into stamp;
  return stamp;
end;
$$;

-- ------------------------------------------------------------ expense ----
create or replace function public.save_expense(trip_id uuid, expense jsonb)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid   uuid := trip_id;
  eid   uuid := (expense->>'id')::uuid;
  stamp timestamptz;
begin
  perform public.assert_trip_access(tid);
  if eid is null then
    raise exception 'an expense id is required';
  end if;

  insert into public.expenses
    (id, trip_id, title, payer_id, total, category, spent_at, position, deleted_at)
  values (
    eid, tid, expense->>'title', (expense->>'payer_id')::uuid,
    (expense->>'total')::numeric, coalesce(expense->>'category', 'other'),
    coalesce((expense->>'spent_at')::timestamptz, now()),
    coalesce((expense->>'position')::int, 0),
    null
  )
  on conflict on constraint expenses_id_trip_key do update
     set title = excluded.title,
         payer_id = excluded.payer_id,
         total = excluded.total,
         category = excluded.category,
         spent_at = excluded.spent_at,
         position = excluded.position,
         deleted_at = null
  returning updated_at into stamp;

  -- Splits and payments are a set belonging to this one expense, with no
  -- identity of their own, so replacing them wholesale is safe and stays
  -- scoped to the expense being written. The balance triggers are deferred,
  -- so the momentary empty state is never observed.
  delete from public.splits   where expense_id = eid;
  delete from public.payments where expense_id = eid;

  insert into public.splits (expense_id, trip_id, member_id, amount)
  select eid, tid, (s->>'member_id')::uuid, (s->>'amount')::numeric
    from jsonb_array_elements(coalesce(expense->'splits', '[]'::jsonb)) s;

  insert into public.payments (expense_id, trip_id, member_id, amount)
  select eid, tid, (p->>'member_id')::uuid, (p->>'amount')::numeric
    from jsonb_array_elements(
           coalesce(nullif(expense->'payments', 'null'::jsonb), '[]'::jsonb)
         ) p;

  return stamp;
end;
$$;

create or replace function public.delete_expense(expense_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid   uuid;
  stamp timestamptz;
begin
  select trip_id into tid from public.expenses where id = expense_id;
  if not found then
    return now();
  end if;
  perform public.assert_trip_access(tid);

  -- The splits stay. They keep the expense balanced, which the deferred
  -- constraint trigger still checks, and they are what a future undo would
  -- need. Only the tombstone is written.
  update public.expenses set deleted_at = now() where id = expense_id
    returning updated_at into stamp;
  return stamp;
end;
$$;

-- -------------------------------------------------------------- grants ----
revoke all on function public.assert_trip_access(uuid) from public, anon;
revoke all on function public.save_trip_meta(uuid, text, timestamptz) from public, anon;
revoke all on function public.save_member(uuid, jsonb) from public, anon;
revoke all on function public.delete_member(uuid) from public, anon;
revoke all on function public.save_expense(uuid, jsonb) from public, anon;
revoke all on function public.delete_expense(uuid) from public, anon;

grant execute on function public.save_trip_meta(uuid, text, timestamptz) to authenticated;
grant execute on function public.save_member(uuid, jsonb) to authenticated;
grant execute on function public.delete_member(uuid) to authenticated;
grant execute on function public.save_expense(uuid, jsonb) to authenticated;
grant execute on function public.delete_expense(uuid) to authenticated;
