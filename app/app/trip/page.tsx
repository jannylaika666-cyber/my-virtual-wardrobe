"use client";

import { useRouter } from "next/navigation";
import { TripsView, useWardrobeStoreContext } from "@/lib/wardrobe";

export default function TripsPage() {
  const store = useWardrobeStoreContext();
  const router = useRouter();

  if (store.loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-neutral-400">
        Loading…
      </div>
    );
  }

  if (store.error) {
    return (
      <div className="h-full flex items-center justify-center text-center px-6">
        <div>
          <p className="text-sm text-neutral-900 mb-1">Couldn&apos;t load your trips</p>
          <p className="text-xs text-neutral-400">{store.error}</p>
        </div>
      </div>
    );
  }

  return (
    <TripsView
      trips={store.trips}
      looks={store.looks}
      items={store.items}
      onCreateTrip={store.createTrip}
      onOpenTrip={(id) => router.push(`/app/trip/${id}`)}
      onDeleteTrip={store.deleteTrip}
    />
  );
}
