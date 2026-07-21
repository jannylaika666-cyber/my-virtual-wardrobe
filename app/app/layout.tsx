"use client";

import { usePathname } from "next/navigation";
import { WardrobeStoreProvider } from "@/lib/wardrobe";
import WardrobeHeader from "./_components/WardrobeHeader";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The Matcher (canvas + sidebar) manages its own internal scroll regions
  // and is meant to fit exactly within the viewport — letting <main> also
  // scroll there just adds a redundant/confusing outer scrollbar. Trips
  // pages have no internal scroll region of their own, so they rely on
  // <main> for normal page-style scrolling.
  const isMatcher = pathname.startsWith("/app/wardrobe");

  return (
    <WardrobeStoreProvider>
      <div className="h-screen bg-white text-neutral-900 flex flex-col">
        <WardrobeHeader />
        <main className={`flex-1 min-h-0 ${isMatcher ? "overflow-hidden" : "overflow-y-auto"}`}>{children}</main>
      </div>
    </WardrobeStoreProvider>
  );
}
