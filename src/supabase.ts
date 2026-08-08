import { createClient, SupabaseClient } from '@supabase/supabase-js';

// The URL and anon key are compiled into the bundle, which is unavoidable for a
// browser app and safe by design: the anon key only lets you ask, and the row
// level security rules in the database decide what comes back.
const url = process.env.REACT_APP_SUPABASE_URL;
const anonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

// Hisaab has to keep working with no account and no network, so a missing or
// misconfigured backend must never break the app. Everything that touches
// Supabase goes through here and copes with null.
export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      })
    : null;

export const isBackendConfigured = supabase !== null;
