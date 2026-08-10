-- Hisaab, hostile writes.
--
-- Every block below is something a signed-in user could send with a REST
-- client or the SQL editor, and every one MUST fail. Run this by hand after
-- changing 0002 or 0003. A block that succeeds is a hole.
--
-- Before running: replace 00000000-0000-0000-0000-000000000000 below with a
-- real id from auth.users, then run each block separately and record whether
-- it raised. Each block rolls itself back, so nothing is left behind.

-- ---------------------------------------------------------------------------
-- 1. Direct table write. The grant is gone, so this never reaches a check.
--    EXPECT: ERROR permission denied for table expenses
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);

insert into public.expenses (id, trip_id, title, payer_id, total)
values (gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 1);
rollback;

-- ---------------------------------------------------------------------------
-- 2. Splits that do not sum to the total.
--    EXPECT: ERROR splits for expense ... sum to 40.00, but the total is 100.00
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);

select public.save_trip('{
  "id":"aaaaaaaa-0000-4000-8000-000000000001","name":"Unbalanced",
  "created_at":"2026-01-01T00:00:00Z",
  "members":[{"id":"bbbbbbbb-0000-4000-8000-000000000001","name":"Asha","active":true,"position":0}],
  "expenses":[{"id":"cccccccc-0000-4000-8000-000000000001","title":"Chai",
    "payer_id":"bbbbbbbb-0000-4000-8000-000000000001","total":100,
    "category":"food","spent_at":"2026-01-01T00:00:00Z","position":0,
    "splits":[{"member_id":"bbbbbbbb-0000-4000-8000-000000000001","amount":40}],
    "payments":null}]}'::jsonb);
rollback;

-- ---------------------------------------------------------------------------
-- 3. A split naming a member who is not in this trip.
--    EXPECT: ERROR ... violates foreign key constraint "splits_member_in_trip"
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);

select public.save_trip('{
  "id":"aaaaaaaa-0000-4000-8000-000000000002","name":"Foreign member",
  "created_at":"2026-01-01T00:00:00Z",
  "members":[{"id":"bbbbbbbb-0000-4000-8000-000000000002","name":"Asha","active":true,"position":0}],
  "expenses":[{"id":"cccccccc-0000-4000-8000-000000000002","title":"Chai",
    "payer_id":"bbbbbbbb-0000-4000-8000-000000000002","total":100,
    "category":"food","spent_at":"2026-01-01T00:00:00Z","position":0,
    "splits":[{"member_id":"dddddddd-0000-4000-8000-000000000099","amount":100}],
    "payments":null}]}'::jsonb);
rollback;

-- ---------------------------------------------------------------------------
-- 4. Payments that do not sum to the total.
--    EXPECT: ERROR payments for expense ... sum to 30.00, but the total is 100.00
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);

select public.save_trip('{
  "id":"aaaaaaaa-0000-4000-8000-000000000003","name":"Bad payers",
  "created_at":"2026-01-01T00:00:00Z",
  "members":[{"id":"bbbbbbbb-0000-4000-8000-000000000003","name":"Asha","active":true,"position":0}],
  "expenses":[{"id":"cccccccc-0000-4000-8000-000000000003","title":"Hotel",
    "payer_id":"bbbbbbbb-0000-4000-8000-000000000003","total":100,
    "category":"hotel","spent_at":"2026-01-01T00:00:00Z","position":0,
    "splits":[{"member_id":"bbbbbbbb-0000-4000-8000-000000000003","amount":100}],
    "payments":[{"member_id":"bbbbbbbb-0000-4000-8000-000000000003","amount":30}]}]}'::jsonb);
rollback;

-- ---------------------------------------------------------------------------
-- 5. A total above the ten million ceiling.
--    EXPECT: ERROR ... violates check constraint "expenses_total_check"
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);

select public.save_trip('{
  "id":"aaaaaaaa-0000-4000-8000-000000000004","name":"Absurd",
  "created_at":"2026-01-01T00:00:00Z",
  "members":[{"id":"bbbbbbbb-0000-4000-8000-000000000004","name":"Asha","active":true,"position":0}],
  "expenses":[{"id":"cccccccc-0000-4000-8000-000000000004","title":"Yacht",
    "payer_id":"bbbbbbbb-0000-4000-8000-000000000004","total":9999999999.99,
    "category":"other","spent_at":"2026-01-01T00:00:00Z","position":0,
    "splits":[{"member_id":"bbbbbbbb-0000-4000-8000-000000000004","amount":9999999999.99}],
    "payments":null}]}'::jsonb);
rollback;

-- ---------------------------------------------------------------------------
-- 6. Reassigning a trip's owner. The revoke in 0003 already blocks the update;
--    the freeze_trip_owner trigger is the backstop if a grant is ever restored.
--    EXPECT: ERROR a trip cannot change owner
-- ---------------------------------------------------------------------------
begin;
grant update on public.trips to authenticated;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);

update public.trips set owner = gen_random_uuid()
 where owner = '00000000-0000-0000-0000-000000000000'::uuid;
rollback;

-- ---------------------------------------------------------------------------
-- 7. Writing into a trip owned by someone else.
--    Run as user A first to create a trip, then re-run the same save_trip as
--    user B by substituting B's id in the jwt claim above.
--    EXPECT as B: ERROR that trip belongs to someone else
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 8. THE ONE THAT MUST SUCCEED. Deleting an expense exercises the cascade case
--    the balance trigger has to survive: removing the expense cascades its
--    splits and fires the check against a parent that no longer exists.
--    Call save_trip twice with the same trip id, the second time with an empty
--    "expenses" array. EXPECT: both succeed, and the expense is gone.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);

select public.save_trip('{
  "id":"aaaaaaaa-0000-4000-8000-000000000008","name":"Delete me",
  "created_at":"2026-01-01T00:00:00Z",
  "members":[{"id":"bbbbbbbb-0000-4000-8000-000000000008","name":"Asha","active":true,"position":0}],
  "expenses":[{"id":"cccccccc-0000-4000-8000-000000000008","title":"Chai",
    "payer_id":"bbbbbbbb-0000-4000-8000-000000000008","total":100,
    "category":"food","spent_at":"2026-01-01T00:00:00Z","position":0,
    "splits":[{"member_id":"bbbbbbbb-0000-4000-8000-000000000008","amount":100}],
    "payments":null}]}'::jsonb);

select public.save_trip('{
  "id":"aaaaaaaa-0000-4000-8000-000000000008","name":"Delete me",
  "created_at":"2026-01-01T00:00:00Z",
  "members":[{"id":"bbbbbbbb-0000-4000-8000-000000000008","name":"Asha","active":true,"position":0}],
  "expenses":[]}'::jsonb);

select count(*) as should_be_zero from public.expenses
 where trip_id = 'aaaaaaaa-0000-4000-8000-000000000008'::uuid;
rollback;

-- ===========================================================================
-- Shared trips (0006). Two real users are needed here, so substitute both ids
-- before running. A is the trip owner; B is a stranger who has never joined.
--   :'uid'  -> user A
--   :'uidb' -> user B
-- ===========================================================================
\set uidb '11111111-1111-1111-1111-111111111111'

-- ---------------------------------------------------------------------------
-- 9. A stranger cannot read a trip they have not joined.
--    EXPECT: 0 rows, not an error. Row level security filters, it does not
--    raise, and a filtered read is indistinguishable from an empty database.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'uidb', 'role', 'authenticated')::text, true);

select count(*) as should_be_zero from public.trips;
select count(*) as should_be_zero from public.expenses;
select count(*) as should_be_zero from public.trip_access;
rollback;

-- ---------------------------------------------------------------------------
-- 10. A stranger cannot write into someone else's trip.
--     EXPECT: ERROR you are not in that trip
--     Substitute a trip id that user A actually owns.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'uidb', 'role', 'authenticated')::text, true);

select public.save_expense(
  (select id from public.trips limit 1),
  '{"id":"cccccccc-0000-4000-8000-000000000010","title":"Not mine",
    "payer_id":"bbbbbbbb-0000-4000-8000-000000000010","total":50,
    "category":"other","spent_at":"2026-01-01T00:00:00Z","position":0,
    "splits":[],"payments":null}'::jsonb);
rollback;

-- ---------------------------------------------------------------------------
-- 11. THE ONE THAT MATTERS MOST. Granting yourself access by inserting a row
--     directly. If this succeeds the join code is decorative and the whole
--     access model is bypassable in a single request.
--     EXPECT: ERROR permission denied for table trip_access
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'uidb', 'role', 'authenticated')::text, true);

insert into public.trip_access (trip_id, user_id)
values ((select id from public.trips limit 1), :'uidb'::uuid);
rollback;

-- ---------------------------------------------------------------------------
-- 12. A closed trip refuses its own code.
--     EXPECT: ERROR that code does not work
--     Run set_join_open(<trip>, false) as the owner first.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 13. Renaming a member somebody else has claimed.
--     Set up as A: claim a member, then attempt the rename as B after B has
--     legitimately joined.
--     EXPECT: ERROR only the person it belongs to can change that name
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 14. A joiner cannot use the owner's controls.
--     Run each as B, after B has joined.
--     EXPECT: ERROR only the trip owner can do that
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'uidb', 'role', 'authenticated')::text, true);

select public.reset_join_code((select id from public.trips limit 1));
rollback;

-- ---------------------------------------------------------------------------
-- 15. The owner cannot leave their own trip, because a trip with no owner has
--     nobody who can delete it or reset its code.
--     EXPECT: ERROR the owner cannot leave their own trip
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'uid', 'role', 'authenticated')::text, true);

select public.leave_trip((select id from public.trips where owner = :'uid'::uuid limit 1));
rollback;

-- ---------------------------------------------------------------------------
-- 16. Claiming twice in one trip.
--     Run claim_member as B against two different members after joining.
--     EXPECT on the second: ERROR you have already claimed someone in this trip
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 17. MUST SUCCEED. The happy path, so a green run is not just everything
--     being broken:
--       as B: join_trip('<code>')            -> returns the trip id
--       as B: claim_member(<trip>, <member>, 'Their Name')
--       as B: save_expense(<trip>, {...})    -> succeeds, B is now in the trip
--       as B: leave_trip(<trip>)             -> succeeds
--       as B: select count(*) from trips     -> back to 0
-- ---------------------------------------------------------------------------
