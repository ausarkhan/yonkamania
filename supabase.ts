import { createClient } from '@supabase/supabase-js';
import { env } from '../env';

// Admin client with service role — bypasses RLS
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// User-scoped client for RLS-safe queries (pass user JWT)
export function supabaseAsUser(accessToken: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Legacy alias for backwards compatibility
export const createSupabaseClient = supabaseAsUser;
