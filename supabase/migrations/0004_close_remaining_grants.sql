-- Hisaab, close the grants 0003 left open.
--
-- 0003 revoked insert, update and delete by name. Running the verification
-- query afterwards showed `authenticated` still holding TRUNCATE, TRIGGER and
-- REFERENCES on all five tables. Enumerating verbs missed the ones nobody
-- thinks of as writes.
--
-- TRUNCATE is the serious one. It is a write, and it is NOT subject to row
-- level security — Postgres exempts it, so no policy applies. Any signed-in
-- user could have emptied every table, for every account, in one statement,
-- and the careful ownership checks in save_trip would never have run.
--
-- TRIGGER is the next one. It lets a caller attach a trigger to a table, and
-- that trigger then fires inside save_trip's security-definer transaction.
--
-- REFERENCES is the mildest: it allows pointing a foreign key at these tables,
-- which can obstruct deletes. Not an escalation, but not needed either.
--
-- The lesson is in the shape of the fix: stop naming the verbs to remove, and
-- name the one to keep instead. A revoke list has to be exhaustive to be
-- correct; a grant list only has to be sufficient.

revoke all on
  public.trips, public.members, public.expenses, public.splits, public.payments
  from public, anon, authenticated;

grant select on
  public.trips, public.members, public.expenses, public.splits, public.payments
  to authenticated;

-- The function grants are unchanged from 0003 and remain correct: execute
-- revoked from public and anon, granted to authenticated only. Restated here
-- so this file is sufficient on its own if 0003 is ever re-run out of order.
revoke all on function public.save_trip(jsonb) from public, anon;
revoke all on function public.delete_trip(uuid) from public, anon;
grant execute on function public.save_trip(jsonb) to authenticated;
grant execute on function public.delete_trip(uuid) to authenticated;
