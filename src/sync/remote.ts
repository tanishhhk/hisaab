import { supabase } from '../supabase';
import { Trip } from '../App';
import { tripToPayload, remoteToTrips, RemoteTrip } from './rows';

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
  'members(id,name,active,position),' +
  'expenses(id,title,payer_id,total,category,spent_at,position,' +
  'splits(member_id,amount),payments(member_id,amount))';

export async function pullTrips(): Promise<Result<Trip[]>> {
  if (!supabase) return NO_BACKEND;
  try {
    const { data, error } = await supabase.from('trips').select(SELECT);
    if (error) return classify(error);
    return { ok: true, value: remoteToTrips((data ?? []) as unknown as RemoteTrip[]) };
  } catch (e) {
    return classify(null, e);
  }
}

export async function pushTrip(trip: Trip): Promise<Result<string>> {
  if (!supabase) return NO_BACKEND;
  try {
    const { data, error } = await supabase.rpc('save_trip', {
      payload: tripToPayload(trip),
    });
    if (error) return classify(error);
    // save_trip returns the server's updated_at. Storing the server's value
    // rather than a local guess is what stops the trips_touch trigger making
    // the remote copy look permanently newer on the next load.
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
