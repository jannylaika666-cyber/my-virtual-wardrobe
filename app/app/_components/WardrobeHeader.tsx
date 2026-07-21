"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function tabClass(active: boolean): string {
  return `px-3 py-1.5 text-sm rounded-full transition duration-200 ${
    active ? "bg-neutral-900 text-white" : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
  }`;
}

export default function WardrobeHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const isTrips = pathname.startsWith("/app/trip");

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/auth/signin");
    router.refresh();
  }

  return (
    <header className="border-b border-neutral-100 px-6 py-4 flex items-center justify-between shrink-0">
      <span className="text-[15px] font-medium tracking-tight">Wardrobe</span>
      <nav className="flex items-center gap-1">
        <Link href="/app/wardrobe" className={tabClass(!isTrips)}>
          Matcher
        </Link>
        <Link href="/app/trip" className={tabClass(isTrips)}>
          Trips
        </Link>
        <button
          onClick={handleLogout}
          disabled={signingOut}
          className="ml-2 px-3 py-1.5 text-sm rounded-full text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 disabled:opacity-50 transition duration-200"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </nav>
    </header>
  );
}
