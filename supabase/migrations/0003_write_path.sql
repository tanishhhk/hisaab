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
  -- across every trip rather than scoped to this one. Without the trip_id
  -- guard below, a caller could name a member or expense id that belongs to
  -- someone else's trip and this upsert would silently overwrite it -- the
  -- same id-guessing attack the trip-level owner check above exists to stop,
  -- one level down where nothing else was checking for it. The guard turns a
  -- foreign-trip id collision into a no-op instead of a write.
  insert into public.members (id, trip_id, name, active, position)
  select (m->>'id')::uuid, tid, m->>'name',
         coalesce((m->>'active')::boolean, true),
         coalesce((m->>'position')::int, 0)
    from jsonb_array_elements(coalesce(payload->'members', '[]'::jsonb)) m
  on conflict (id) do update
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
  on conflict (id) do update
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
         jsonb_array_elements(coalesce(e->'payments', '[]'::jsonb)) p;

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
begin
  if caller is null then
    raise exception 'not signed in';
  end if;

  select owner into holder from public.trips where id = trip_id;
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
  -- edges between them.
  delete from public.payments where trip_id = delete_trip.trip_id;
  delete from public.splits   where trip_id = delete_trip.trip_id;
  delete from public.expenses where trip_id = delete_trip.trip_id;
  delete from public.members  where trip_id = delete_trip.trip_id;
  delete from public.trips    where id = delete_trip.trip_id;
end;
$$;

revoke all on function public.save_trip(jsonb) from public, anon;
revoke all on function public.delete_trip(uuid) from public, anon;
grant execute on function public.save_trip(jsonb) to authenticated;
grant execute on function public.delete_trip(uuid) to authenticated;
