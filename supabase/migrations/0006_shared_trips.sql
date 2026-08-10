-- Hisaab, shared trips.
--
-- Phase B. Access moves from "the one owner" to "everyone who joined", the
-- trip gains a join code, and a person can claim the member row that is them.
--
-- Ordering matters here: the access helper and the policies that use it must
-- land before anything relies on them, and assert_trip_access is redefined at
-- the end so every RPC written in 0005 becomes collaborative without being
-- touched.

-- --------------------------------------------------------------- access ----
create table if not exists public.trip_access (
  trip_id   uuid not null references public.trips(id) on delete cascade,
  user_id   uuid not null references auth.users(id)  on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
create index if not exists trip_access_user_idx on public.trip_access (user_id);

alter table public.trip_access enable row level security;

-- security definer, and not for convenience: a policy on trips that queried
-- trip_access as the caller would re-enter row level security and recurse.
create or replace function public.has_trip_access(t uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.trips where id = t and owner = auth.uid())
      or exists (select 1 from public.trip_access
                  where trip_id = t and user_id = auth.uid());
$$;

drop policy if exists trip_access_visible on public.trip_access;
create policy trip_access_visible on public.trip_access
  for select using (public.has_trip_access(trip_id));

-- ------------------------------------------------------------- identity ----
-- Nullable: a member typed in before that person has an account is a plain
-- label, which is what makes a trip typed up afterwards work unchanged.
alter table public.members add column if not exists user_id uuid references auth.users(id) on delete set null;

-- One account claims at most one member per trip. Without this a single
-- person could be two people in the same settlement.
create unique index if not exists members_one_claim_per_trip
  on public.members (trip_id, user_id) where user_id is not null;

-- ----------------------------------------------------------- join codes ----
alter table public.trips add column if not exists join_code text unique;
alter table public.trips add column if not exists join_open boolean not null default true;

-- No O, 0, I or 1: the code has to survive being read out loud across a table.
create or replace function public.gen_join_code() returns text
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  i integer;
begin
  loop
    candidate := '';
    for i in 1..8 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.trips where join_code = candidate);
  end loop;
  return candidate;
end;
$$;

-- Existing trips predate the column and would otherwise be unshareable.
update public.trips set join_code = public.gen_join_code() where join_code is null;

-- ------------------------------------------------------------ policies ----
-- Every table's visibility now follows access rather than ownership. Writes
-- stay revoked (0003, 0004), so these are select-only by design: the only way
-- data changes is through the security definer functions below.
drop policy if exists trips_owner_all on public.trips;
drop policy if exists trips_visible on public.trips;
create policy trips_visible on public.trips
  for select using (public.has_trip_access(id));

drop policy if exists members_via_trip on public.members;
drop policy if exists members_visible on public.members;
create policy members_visible on public.members
  for select using (public.has_trip_access(trip_id));

drop policy if exists expenses_via_trip on public.expenses;
drop policy if exists expenses_visible on public.expenses;
create policy expenses_visible on public.expenses
  for select using (public.has_trip_access(trip_id));

drop policy if exists splits_via_expense on public.splits;
drop policy if exists splits_visible on public.splits;
create policy splits_visible on public.splits
  for select using (public.has_trip_access(trip_id));

drop policy if exists payments_via_expense on public.payments;
drop policy if exists payments_visible on public.payments;
create policy payments_visible on public.payments
  for select using (public.has_trip_access(trip_id));

-- --------------------------------------------------------------- owner ----
create or replace function public.assert_trip_owner(t uuid) returns void
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
    raise exception 'only the trip owner can do that';
  end if;
end;
$$;

-- ------------------------------------------------------------- joining ----
create or replace function public.join_trip(code text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  caller uuid := auth.uid();
  t      uuid;
begin
  if caller is null then
    raise exception 'not signed in';
  end if;

  select id into t from public.trips
   where join_code = upper(trim(join_trip.code)) and join_open;
  if not found then
    -- One message for a wrong code and for a closed trip. Distinguishing them
    -- would let someone probe which codes exist.
    raise exception 'that code does not work';
  end if;

  -- Joining twice is a no-op rather than an error: people tap the link again.
  insert into public.trip_access (trip_id, user_id)
  values (t, caller)
  on conflict (trip_id, user_id) do nothing;

  return t;
end;
$$;

create or replace function public.reset_join_code(trip_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid  uuid := trip_id;
  code text;
begin
  perform public.assert_trip_owner(tid);
  code := public.gen_join_code();
  update public.trips set join_code = code where id = tid;
  return code;
end;
$$;

create or replace function public.set_join_open(trip_id uuid, open boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid uuid := trip_id;
begin
  perform public.assert_trip_owner(tid);
  update public.trips set join_open = set_join_open.open where id = tid;
end;
$$;

-- -------------------------------------------------------------- claims ----
create or replace function public.claim_member(trip_id uuid, member_id uuid, display_name text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid    uuid := trip_id;
  mid    uuid := member_id;
  caller uuid := auth.uid();
  holder uuid;
begin
  perform public.assert_trip_access(tid);

  if exists (select 1 from public.members
              where public.members.trip_id = tid and public.members.user_id = caller) then
    raise exception 'you have already claimed someone in this trip';
  end if;

  select public.members.user_id into holder
    from public.members where id = mid and public.members.trip_id = tid;
  if not found then
    raise exception 'no such member in this trip';
  end if;
  if holder is not null then
    raise exception 'somebody has already claimed that name';
  end if;

  -- The claim and the name are one act: the label typed by whoever set the
  -- trip up is a placeholder, and this is the moment its subject takes it over.
  update public.members
     set user_id = caller,
         name = coalesce(nullif(trim(display_name), ''), name)
   where id = mid;
end;
$$;

-- -------------------------------------------------------------- leaving ----
create or replace function public.leave_trip(trip_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid    uuid := trip_id;
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'not signed in';
  end if;
  if exists (select 1 from public.trips where id = tid and owner = caller) then
    -- A trip with no owner has nobody who can delete it or reset its code.
    raise exception 'the owner cannot leave their own trip';
  end if;

  delete from public.trip_access
   where public.trip_access.trip_id = tid and public.trip_access.user_id = caller;

  -- The member row stays. It holds their payments, and the settlement still
  -- has to balance after they go.
  update public.members
     set user_id = null
   where public.members.trip_id = tid and public.members.user_id = caller;
end;
$$;

create or replace function public.revoke_access(trip_id uuid, user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid uuid := trip_id;
  uid uuid := user_id;
begin
  perform public.assert_trip_owner(tid);
  if exists (select 1 from public.trips where id = tid and owner = uid) then
    raise exception 'the owner cannot be removed from their own trip';
  end if;

  delete from public.trip_access
   where public.trip_access.trip_id = tid and public.trip_access.user_id = uid;
  update public.members
     set user_id = null
   where public.members.trip_id = tid and public.members.user_id = uid;
end;
$$;

-- ------------------------------------------------- the one-line switch ----
-- Every RPC written in 0005 calls this. Replacing its body is what turns the
-- whole write path collaborative, with no chance that one of them kept an
-- inline owner check and quietly stayed single-user.
create or replace function public.assert_trip_access(t uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if not exists (select 1 from public.trips where id = t) then
    raise exception 'no such trip';
  end if;
  if not public.has_trip_access(t) then
    raise exception 'you are not in that trip';
  end if;
end;
$$;

-- ------------------------------------------------------ name ownership ----
-- An unclaimed member can be renamed by anyone in the trip, because somebody
-- has to be able to write a name before that person has an account. A claimed
-- member can be renamed only by its claimant. Enforced here rather than in the
-- interface, because the interface is not what an attacker uses.
create or replace function public.save_member(trip_id uuid, member jsonb)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  tid    uuid := trip_id;
  mid    uuid := (member->>'id')::uuid;
  caller uuid := auth.uid();
  holder uuid;
  was    text;
  stamp  timestamptz;
begin
  perform public.assert_trip_access(tid);

  select public.members.user_id, public.members.name into holder, was
    from public.members where id = mid;

  if found and holder is not null and holder <> caller
     and was is distinct from (member->>'name') then
    raise exception 'only % can change that name', 'the person it belongs to';
  end if;

  insert into public.members (id, trip_id, name, active, position, deleted_at)
  values (
    mid, tid, member->>'name',
    coalesce((member->>'active')::boolean, true),
    coalesce((member->>'position')::int, 0),
    null
  )
  on conflict on constraint members_id_trip_key do update
     set name = excluded.name,
         active = excluded.active,
         position = excluded.position,
         deleted_at = null
  returning updated_at into stamp;

  return stamp;
end;
$$;

-- -------------------------------------------------------------- grants ----
revoke all on function public.has_trip_access(uuid) from public, anon;
revoke all on function public.assert_trip_owner(uuid) from public, anon;
revoke all on function public.gen_join_code() from public, anon;
revoke all on function public.join_trip(text) from public, anon;
revoke all on function public.reset_join_code(uuid) from public, anon;
revoke all on function public.set_join_open(uuid, boolean) from public, anon;
revoke all on function public.claim_member(uuid, uuid, text) from public, anon;
revoke all on function public.leave_trip(uuid) from public, anon;
revoke all on function public.revoke_access(uuid, uuid) from public, anon;

-- trip_access is a new table, and Supabase's default privileges hand new
-- tables in public to authenticated in full. Left alone, anyone could INSERT
-- their own row and join any trip they liked, which would make the join code
-- decorative. Same lesson as TRUNCATE in 0004: name what to keep, never what
-- to remove.
revoke all on public.trip_access from public, anon, authenticated;
grant select on public.trip_access to authenticated;

-- Row level security calls this as the querying user, not as its definer, so
-- every SELECT on every table needs EXECUTE on it. Without this grant the
-- policies above fail and the app reads nothing at all.
grant execute on function public.has_trip_access(uuid) to authenticated;
grant execute on function public.join_trip(text) to authenticated;
grant execute on function public.reset_join_code(uuid) to authenticated;
grant execute on function public.set_join_open(uuid, boolean) to authenticated;
grant execute on function public.claim_member(uuid, uuid, text) to authenticated;
grant execute on function public.leave_trip(uuid) to authenticated;
grant execute on function public.revoke_access(uuid, uuid) to authenticated;
