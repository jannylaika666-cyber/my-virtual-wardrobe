"use client";

import { WardrobeStoreProvider } from "@/lib/wardrobe";
import WardrobeHeader from "./_components/WardrobeHeader";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <WardrobeStoreProvider>
      <div className="h-screen bg-white text-neutral-900 flex flex-col">
        <WardrobeHeader />
        <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
      </div>
    </WardrobeStoreProvider>
  );
}
