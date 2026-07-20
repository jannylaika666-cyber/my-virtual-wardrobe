import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for use in Client Components ("use client"). Session is
 * stored in cookies (via @supabase/ssr) so the server (proxy, Server
 * Components) can read the same session — that's what makes route
 * protection in proxy.ts possible.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Add them to .env.local (see SETUP.md)."
    );
  }

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}

export const WARDROBE_BUCKET = "wardrobe-images";
