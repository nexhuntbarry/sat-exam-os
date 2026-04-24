import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Anon client — respects RLS. Use for public reads if needed.
 */
export function getAnonClient() {
  return createClient(supabaseUrl, supabaseAnonKey);
}

/**
 * Service role client — bypasses RLS.
 * Use ONLY in Server Components, Route Handlers, or Server Actions.
 * Never expose to the browser.
 */
export function getServiceClient() {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
