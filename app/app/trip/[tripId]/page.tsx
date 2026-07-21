"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { TripDetailView, useWardrobeStoreContext } from "@/lib/wardrobe";

export default function TripDetailPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = use(params);
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
          <p className="text-sm text-neutral-900 mb-1">Couldn&apos;t load this trip</p>
          <p className="text-xs text-neutral-400">{store.error}</p>
        </div>
      </div>
    );
  }

  const trip = store.trips.find((t) => t.id === tripId);
  if (!trip) {
    return (
      <div className="h-full flex items-center justify-center text-center px-6">
        <div>
          <p className="text-sm text-neutral-900 mb-1">Trip not found</p>
          <p className="text-xs text-neutral-400 mb-4">It may have been deleted.</p>
          <button
            onClick={() => router.push("/app/trip")}
            className="text-xs text-neutral-500 hover:text-neutral-900 underline transition duration-150"
          >
            Back to all trips
          </button>
        </div>
      </div>
    );
  }

  return (
    <TripDetailView
      trip={trip}
      looks={store.looks}
      items={store.items}
      onBack={() => router.push("/app/trip")}
      onDeleteLook={store.deleteLook}
      onEditLook={(look) => router.push(`/app/wardrobe?editLook=${look.id}`)}
    />
  );
}
