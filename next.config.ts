import type { NextConfig } from "next";

// Derived from the env var (rather than hardcoded) so switching Supabase
// projects doesn't require touching this file.
const supabaseHostname = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
  : undefined;

const nextConfig: NextConfig = {
  images: {
    remotePatterns: supabaseHostname
      ? [
          {
            protocol: "https",
            hostname: supabaseHostname,
            pathname: "/storage/v1/object/public/**",
          },
        ]
      : [],
    // Wardrobe photos are immutable once uploaded (a new upload gets a new
    // path, never overwrites an existing one), so it's safe to cache
    // optimized versions for a long time — 31 days.
    minimumCacheTTL: 2678400,
  },
};

export default nextConfig;
