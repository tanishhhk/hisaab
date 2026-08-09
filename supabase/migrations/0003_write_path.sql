-- Hisaab, the only way data enters the database.
--
-- PostgREST exposes every granted table as a writable endpoint, so RLS alone
-- leaves four tables times four verbs of attack surface. Revoking the write
-- grants and routing everything through one function reduces that to a single
-- validated entry point, and makes each save a transaction, which is what
-- lets the deferred balance checks in 0002 do their job.

revoke insert, update, delete on
  public.trips, public.members, public.expenses, public.splits, public.payments
  from authenticated, anon;

grant select on public.payments to authenticated;

-- security definer bypasses RLS, so this function must re-derive ownership
-- itself. search_path is pinned because a security definer function with a
-- mutable search path lets the caller shadow an unqualified name with their
-- own object and run it as the definer.
create or replace function public.save_trip(payload jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  tid    uuid;
  holder uuid;
  stamp  timestamptz;
begin
  if caller is null then
    raise exception 'not signed in';
  end if;

  tid := (payload->>'id')::uuid;
  if tid is null then
    raise exception 'a trip id is required';
  end if;

  -- The payload's owner, if it carries one, is ignored entirely. This is what
  -- stops a caller writing into someone else's trip by guessing its id.
  select owner into holder from public.trips where id = tid;
  if found and holder <> caller then
    raise exception 'that trip belongs to someone else';
  end if;

  insert into public.trips (id, owner, name, created_at)
  values (tid, caller, payload->>'name',
          coalesce((payload->>'created_at')::timestamptz, now()))
  on conflict (id) do update set name = excluded.name
  returning updated_at into stamp;

  -- members.id and expenses.id are client-supplied primary keys, global
  -- across every trip rather than scoped to this one. A caller could name a
  -- member or expense id that belongs to someone else's trip -- the same
  -- id-guessing attack the trip-level owner check above exists to stop, one
  -- level down where nothing else was checking for it. The arbiter below is
  -- the composite (id, trip_id) key from 0002, not the bare id primary key,
  -- so a foreign-trip id does not count as a conflict under it: the insert
  -- proceeds and hits the plain primary key instead, aborting the whole save
  -- loudly. That is deliberately louder than the where clause alone would be
  -- -- ON CONFLICT (id) DO UPDATE ... WHERE false is a silent no-op, which
  -- for a member the caller just added and has nothing else pointing at yet
  -- would mean the save reports success, stamps a fresh updated_at, and that
  -- incomplete state wins on every other device. The where clause stays too:
  -- harmless on a genuine same-trip conflict, and it documents the intent.
  insert into public.members (id, trip_id, name, active, position)
  select (m->>'id')::uuid, tid, m->>'name',
         coalesce((m->>'active')::boolean, true),
         coalesce((m->>'position')::int, 0)
    from jsonb_array_elements(coalesce(payload->'members', '[]'::jsonb)) m
  on conflict (id, trip_id) do update
     set name = excluded.name,
         active = excluded.active,
         position = excluded.position
   where public.members.trip_id = tid;

  insert into public.expenses
    (id, trip_id, title, payer_id, total, category, spent_at, position)
  select (e->>'id')::uuid, tid, e->>'title', (e->>'payer_id')::uuid,
         (e->>'total')::numeric, coalesce(e->>'category', 'other'),
         coalesce((e->>'spent_at')::timestamptz, now()),
         coalesce((e->>'position')::int, 0)
    from jsonb_array_elements(coalesce(payload->'expenses', '[]'::jsonb)) e
  on conflict (id, trip_id) do update
     set title = excluded.title,
         payer_id = excluded.payer_id,
         total = excluded.total,
         category = excluded.category,
         spent_at = excluded.spent_at,
         position = excluded.position
   where public.expenses.trip_id = tid;

  -- Splits and payments are sets keyed by (expense, member) with no identity
  -- of their own, so replacing them wholesale is simpler and cheaper than
  -- diffing. Safe inside the transaction: the balance triggers are deferred
  -- to commit, so the momentary state of zero splits is never observed. A
  -- split or payment naming an expense_id from another trip cannot slip in
  -- here either: splits_expense_in_trip and payments_expense_in_trip are
  -- composite foreign keys on (expense_id, trip_id), and trip_id is always
  -- tid, so the pair only matches a row that genuinely belongs to this trip.
  delete from public.splits where trip_id = tid;
  insert into public.splits (expense_id, trip_id, member_id, amount)
  select (e->>'id')::uuid, tid, (s->>'member_id')::uuid, (s->>'amount')::numeric
    from jsonb_array_elements(coalesce(payload->'expenses', '[]'::jsonb)) e,
         jsonb_array_elements(coalesce(e->'splits', '[]'::jsonb)) s;

  delete from public.payments where trip_id = tid;
  insert into public.payments (expense_id, trip_id, member_id, amount)
  select (e->>'id')::uuid, tid, (p->>'member_id')::uuid, (p->>'amount')::numeric
    from jsonb_array_elements(coalesce(payload->'expenses', '[]'::jsonb)) e,
         -- payments is the one field the client sends as a literal JSON
         -- null (see src/sync/rows.ts) rather than an absent key, to mean
         -- "one payer covered the whole total". e->'payments' then yields the
         -- jsonb scalar 'null', not SQL NULL, which coalesce alone would pass
         -- straight through into jsonb_array_elements and raise "cannot
         -- extract elements from a scalar". nullif catches that scalar and
         -- turns it into SQL NULL first, so coalesce can do its job.
         jsonb_array_elements(coalesce(nullif(e->'payments', 'null'::jsonb), '[]'::jsonb)) p;

  -- Rows the payload no longer contains. Children first: expenses.payer_id
  -- and splits.member_id are on delete restrict, so a member cannot go until
  -- everything pointing at them has. Splits and payments for a dropped
  -- expense are already gone, wiped by the delete above.
  delete from public.expenses x
   where x.trip_id = tid
     and not exists (
       select 1 from jsonb_array_elements(coalesce(payload->'expenses', '[]'::jsonb)) e
        where (e->>'id')::uuid = x.id
     );

  delete from public.members m
   where m.trip_id = tid
     and not exists (
       select 1 from jsonb_array_elements(coalesce(payload->'members', '[]'::jsonb)) j
        where (j->>'id')::uuid = m.id
     );

  return stamp;
end;
$$;

create or replace function public.delete_trip(trip_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  holder uuid;
  -- Every child table also has a column named trip_id, so a bare trip_id
  -- reference below would be ambiguous between the parameter and the column
  -- under the default plpgsql.variable_conflict = error, and the function
  -- would raise on every call. Copying the parameter into a local with a
  -- distinct name (as save_trip already does with tid) sidesteps that
  -- without renaming the parameter itself, which is part of the RPC's API.
  tid    uuid := trip_id;
begin
  if caller is null then
    raise exception 'not signed in';
  end if;

  select owner into holder from public.trips where id = tid;
  if not found then
    -- Already gone. Silent success, so a retried tombstone settles instead of
    -- failing forever.
    return;
  end if;
  if holder <> caller then
    raise exception 'that trip belongs to someone else';
  end if;

  -- Children first, for the same on delete restrict reason as above. The
  -- trips cascade would handle members and expenses, but not the restrict
  -- edges between them. The left side of each comparison is schema- and
  -- table-qualified, not bare trip_id: the tid local above does not remove
  -- the trip_id parameter from scope, so a bare trip_id here would still be
  -- ambiguous between the parameter and the column on every one of these
  -- tables.
  delete from public.payments where public.payments.trip_id = tid;
  delete from public.splits   where public.splits.trip_id   = tid;
  delete from public.expenses where public.expenses.trip_id = tid;
  delete from public.members  where public.members.trip_id  = tid;
  delete from public.trips    where id = tid;
end;
$$;

revoke all on function public.save_trip(jsonb) from public, anon;
revoke all on function public.delete_trip(uuid) from public, anon;
grant execute on function public.save_trip(jsonb) to authenticated;
grant execute on function public.delete_trip(uuid) to authenticated;
