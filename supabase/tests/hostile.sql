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
