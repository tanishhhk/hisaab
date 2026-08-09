import { supabase } from '../supabase';
import { Trip } from '../App';
import { memberPayload, expensePayload, remoteToTrips, RemoteTrip } from './rows';
import { Member, Expense } from '../App';

export type Failure = { ok: false; kind: 'network' | 'auth' | 'db'; message: string };
export type Result<T> = { ok: true; value: T } | Failure;

// Nothing here throws. The UI has to distinguish "you are offline" from "your
// session expired" from "the database said no", because the three want
// different words and different recovery.
function classify(error: { message?: string; code?: string } | null, thrown?: unknown): Failure {
  if (thrown) return { ok: false, kind: 'network', message: 'Could not reach the server.' };
  const message = error?.message ?? 'Something went wrong.';
  const code = error?.code ?? '';
  if (code === 'PGRST301' || /jwt|token|not signed in/i.test(message)) {
    return { ok: false, kind: 'auth', message: 'Your session expired.' };
  }
  if (/fetch|network/i.test(message)) {
    return { ok: false, kind: 'network', message: 'Could not reach the server.' };
  }
  return { ok: false, kind: 'db', message };
}

const NO_BACKEND: Failure = {
  ok: false,
  kind: 'db',
  message: 'Sync is not configured.',
};

// One round trip, not five. PostgREST embeds the children through the
// foreign keys, so the whole account arrives as nested JSON. The embedded
// arrays come back in no guaranteed order, which is why remoteToTrip sorts
// by position rather than trusting what arrives.
const SELECT =
  'id,name,created_at,updated_at,' +
  'members(id,name,active,position,updated_at),' +
  'expenses(id,title,payer_id,total,category,spent_at,position,updated_at,' +
  'splits(member_id,amount),payments(member_id,amount))';

export async function pullTrips(): Promise<Result<Trip[]>> {
  if (!supabase) return NO_BACKEND;
  try {
    const { data, error } = await supabase
      .from('trips')
      .select(SELECT)
      // Tombstoned rows are dropped here, not in the client. reconcile reads
      // "local, clean, and absent from the server" as a deletion, so leaving
      // them out of the response is what carries a delete between devices.
      .is('members.deleted_at', null)
      .is('expenses.deleted_at', null);
    if (error) return classify(error);
    return { ok: true, value: remoteToTrips((data ?? []) as unknown as RemoteTrip[]) };
  } catch (e) {
    return classify(null, e);
  }
}

export async function pushTripMeta(
  id: string,
  name: string,
  createdAt?: string
): Promise<Result<string>> {
  return rpcStamp('save_trip_meta', { trip_id: id, name, created_at: createdAt ?? null });
}

export async function pushMember(
  tripId: string,
  member: Member,
  index: number
): Promise<Result<string>> {
  return rpcStamp('save_member', { trip_id: tripId, member: memberPayload(member, index) });
}

export async function pushExpense(
  tripId: string,
  expense: Expense,
  index: number,
  members: Member[]
): Promise<Result<string>> {
  return rpcStamp('save_expense', {
    trip_id: tripId,
    expense: expensePayload(expense, index, members),
  });
}

export async function removeMember(id: string): Promise<Result<string>> {
  return rpcStamp('delete_member', { member_id: id });
}

export async function removeExpense(id: string): Promise<Result<string>> {
  return rpcStamp('delete_expense', { expense_id: id });
}

// Every write returns the server's stamp for the row it touched. Storing that
// rather than a local guess is what stops the touch triggers making the remote
// copy look permanently newer on the next pull.
async function rpcStamp(fn: string, args: Record<string, unknown>): Promise<Result<string>> {
  if (!supabase) return NO_BACKEND;
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return classify(error);
    return { ok: true, value: String(data) };
  } catch (e) {
    return classify(null, e);
  }
}

export async function deleteTrip(id: string): Promise<Result<null>> {
  if (!supabase) return NO_BACKEND;
  try {
    const { error } = await supabase.rpc('delete_trip', { trip_id: id });
    if (error) return classify(error);
    return { ok: true, value: null };
  } catch (e) {
    return classify(null, e);
  }
}
