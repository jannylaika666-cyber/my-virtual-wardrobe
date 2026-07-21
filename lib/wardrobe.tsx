"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient, WARDROBE_BUCKET } from "@/lib/supabase/client";

/* -------------------------------------------------------------------------
 * Virtual Wardrobe — shared data layer and cross-page view components.
 *
 * Data model: three Postgres tables (wardrobe_items, looks, trips) plus a
 * public Storage bucket for photos, each row scoped to the signed-in user
 * via `user_id` + Row Level Security. See supabase/migrations for the full
 * schema.
 *
 * `WardrobeStoreProvider` is mounted once in app/app/layout.tsx, so the
 * fetch + realtime subscription (and any in-progress canvas arrangement)
 * survive client-side navigation between /app/wardrobe, /app/trip, and
 * /app/trip/[tripId] — they're all siblings under that shared layout.
 * ---------------------------------------------------------------------- */

export const CATEGORIES = [
  "Top",
  "Bottom",
  "Accessory",
  "Bag",
  "Footwear",
  "Outer",
  "Swimwear",
  "Activewear",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface WardrobeItem {
  id: string;
  name: string;
  category: Category;
  imageUrl: string;
  imagePath: string; // storage object path ("<user_id>/<file>.png"), needed to delete the file
  createdAt: number;
  lastUsedAt: number; // bumped whenever the item is added to the canvas; sorts the sidebar
}

export interface CanvasItem {
  id: string;
  itemId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

export interface Look {
  id: string;
  name: string;
  canvasItems: CanvasItem[];
  tripId: string | null;
  createdAt: number;
}

export interface Trip {
  id: string;
  name: string;
  createdAt: number;
}

export const CANVAS_WIDTH = 720;
export const CANVAS_HEIGHT = 560;

/* ---------------------------- Utilities --------------------------------- */

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Downscales an upload client-side to keep storage/transfer small. Returns a Blob ready to upload. */
export async function downscaleImage(file: File, maxDimension = 600): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to encode image"));
    }, "image/png");
  });
}

/* ------------------------------ Row mapping -------------------------------- */

type Row = Record<string, any>;

function mapItemRow(row: Row): WardrobeItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category as Category,
    imageUrl: row.image_url,
    imagePath: row.image_path,
    createdAt: new Date(row.created_at).getTime(),
    lastUsedAt: new Date(row.last_used_at ?? row.created_at).getTime(),
  };
}

function mapLookRow(row: Row): Look {
  return {
    id: row.id,
    name: row.name,
    canvasItems: Array.isArray(row.canvas_items) ? (row.canvas_items as CanvasItem[]) : [],
    tripId: row.trip_id ?? null,
    createdAt: new Date(row.created_at).getTime(),
  };
}

function mapTripRow(row: Row): Trip {
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).getTime(),
  };
}

function applyRealtimeChange<T extends { id: string }>(
  setter: React.Dispatch<React.SetStateAction<T[]>>,
  payload: RealtimePostgresChangesPayload<Row>,
  mapRow: (row: Row) => T
) {
  if (payload.eventType === "DELETE") {
    const oldId = (payload.old as Row | undefined)?.id;
    if (!oldId) return;
    setter((prev) => prev.filter((item) => item.id !== oldId));
    return;
  }
  const mapped = mapRow(payload.new as Row);
  setter((prev) => {
    const exists = prev.some((item) => item.id === mapped.id);
    if (exists) return prev.map((item) => (item.id === mapped.id ? mapped : item));
    return [mapped, ...prev];
  });
}

/* ------------------------------ Store ------------------------------------ */

function useWardrobeStore() {
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<WardrobeItem[]>([]);
  const [looks, setLooks] = useState<Look[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [canvasItems, setCanvasItems] = useState<CanvasItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initial load. RLS scopes every query to the signed-in user automatically.
  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const [itemsRes, looksRes, tripsRes] = await Promise.all([
        supabase.from("wardrobe_items").select("*").order("created_at", { ascending: false }),
        supabase.from("looks").select("*").order("created_at", { ascending: false }),
        supabase.from("trips").select("*").order("created_at", { ascending: false }),
      ]);
      if (!active) return;

      const firstError = itemsRes.error || looksRes.error || tripsRes.error;
      if (firstError) {
        setError(firstError.message);
        setLoading(false);
        return;
      }

      setItems((itemsRes.data ?? []).map(mapItemRow));
      setLooks((looksRes.data ?? []).map(mapLookRow));
      setTrips((tripsRes.data ?? []).map(mapTripRow));
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [supabase]);

  // Realtime subscriptions — this is what makes changes on one device show
  // up on another without a manual refresh. RLS applies to realtime too, so
  // this only ever delivers the signed-in user's own rows.
  useEffect(() => {
    const channel = supabase
      .channel("wardrobe-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "wardrobe_items" },
        (payload) => applyRealtimeChange(setItems, payload, mapItemRow)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "looks" },
        (payload) => applyRealtimeChange(setLooks, payload, mapLookRow)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trips" },
        (payload) => applyRealtimeChange(setTrips, payload, mapTripRow)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  const addItem = useCallback(
    async (data: { name: string; category: Category; blob: Blob }) => {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        throw new Error("You're not signed in. Please sign in again.");
      }

      const path = `${userData.user.id}/${makeId()}.png`;
      const { error: uploadError } = await supabase.storage
        .from(WARDROBE_BUCKET)
        .upload(path, data.blob, { contentType: "image/png", upsert: false });
      if (uploadError) throw uploadError;

      const {
        data: { publicUrl },
      } = supabase.storage.from(WARDROBE_BUCKET).getPublicUrl(path);

      const { data: row, error: insertError } = await supabase
        .from("wardrobe_items")
        .insert({ name: data.name, category: data.category, image_url: publicUrl, image_path: path })
        .select()
        .single();
      if (insertError) throw insertError;

      const newItem = mapItemRow(row);
      setItems((s) => [newItem, ...s]);
      return newItem;
    },
    [supabase]
  );

  const removeItem = useCallback(
    async (item: WardrobeItem) => {
      await supabase.storage.from(WARDROBE_BUCKET).remove([item.imagePath]);
      const { error: deleteError } = await supabase.from("wardrobe_items").delete().eq("id", item.id);
      if (deleteError) throw deleteError;
      setItems((s) => s.filter((i) => i.id !== item.id));
      setCanvasItems((s) => s.filter((c) => c.itemId !== item.id));
    },
    [supabase]
  );

  const renameItem = useCallback(
    async (id: string, name: string) => {
      const { error: updateError } = await supabase.from("wardrobe_items").update({ name }).eq("id", id);
      if (updateError) throw updateError;
      setItems((s) => s.map((i) => (i.id === id ? { ...i, name } : i)));
    },
    [supabase]
  );

  const addToCanvas = useCallback(
    (itemId: string) => {
      setCanvasItems((s) => {
        const maxZ = s.reduce((m, c) => Math.max(m, c.zIndex), 0);
        const offset = (s.length % 6) * 14;
        const newCanvasItem: CanvasItem = {
          id: makeId(),
          itemId,
          x: 40 + offset,
          y: 40 + offset,
          width: 200,
          height: 200,
          zIndex: maxZ + 1,
        };
        return [...s, newCanvasItem];
      });

      // Record usage so the sidebar can sort by most-recently-used.
      const usedAt = new Date().toISOString();
      setItems((s) => s.map((i) => (i.id === itemId ? { ...i, lastUsedAt: new Date(usedAt).getTime() } : i)));
      supabase
        .from("wardrobe_items")
        .update({ last_used_at: usedAt })
        .eq("id", itemId)
        .then(({ error }) => {
          if (error) console.error("Couldn't record item usage:", error);
        });
    },
    [supabase]
  );

  const updateCanvasItem = useCallback((id: string, patch: Partial<CanvasItem>) => {
    setCanvasItems((s) => s.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const bringToFront = useCallback((id: string) => {
    setCanvasItems((s) => {
      const maxZ = s.reduce((m, c) => Math.max(m, c.zIndex), 0);
      return s.map((c) => (c.id === id ? { ...c, zIndex: maxZ + 1 } : c));
    });
  }, []);

  const removeFromCanvas = useCallback((id: string) => {
    setCanvasItems((s) => s.filter((c) => c.id !== id));
  }, []);

  const clearCanvas = useCallback(() => setCanvasItems([]), []);

  const loadLookOntoCanvas = useCallback((look: Look) => {
    setCanvasItems(look.canvasItems.map((c) => ({ ...c, id: makeId() })));
  }, []);

  const createTrip = useCallback(
    async (name: string) => {
      const { data: row, error: insertError } = await supabase
        .from("trips")
        .insert({ name: name.trim() || "Untitled trip" })
        .select()
        .single();
      if (insertError) throw insertError;
      const trip = mapTripRow(row);
      setTrips((s) => [trip, ...s]);
      return trip;
    },
    [supabase]
  );

  const deleteTrip = useCallback(
    async (id: string) => {
      const { error: deleteError } = await supabase.from("trips").delete().eq("id", id);
      if (deleteError) throw deleteError;
      setTrips((s) => s.filter((t) => t.id !== id));
      setLooks((s) => s.map((l) => (l.tripId === id ? { ...l, tripId: null } : l)));
    },
    [supabase]
  );

  const saveLook = useCallback(
    async (
      currentCanvasItems: CanvasItem[],
      name: string,
      tripId: string | null,
      newTripName?: string
    ) => {
      if (currentCanvasItems.length === 0) return;

      let finalTripId = tripId;
      if (!finalTripId && newTripName && newTripName.trim()) {
        const trip = await createTrip(newTripName);
        finalTripId = trip.id;
      }

      const { data: row, error: insertError } = await supabase
        .from("looks")
        .insert({
          name: name.trim() || "Untitled look",
          canvas_items: currentCanvasItems,
          trip_id: finalTripId,
        })
        .select()
        .single();
      if (insertError) throw insertError;

      setLooks((s) => [mapLookRow(row), ...s]);
    },
    [createTrip, supabase]
  );

  const deleteLook = useCallback(
    async (id: string) => {
      const { error: deleteError } = await supabase.from("looks").delete().eq("id", id);
      if (deleteError) throw deleteError;
      setLooks((s) => s.filter((l) => l.id !== id));
    },
    [supabase]
  );

  return {
    items,
    looks,
    trips,
    canvasItems,
    loading,
    error,
    addItem,
    removeItem,
    renameItem,
    addToCanvas,
    updateCanvasItem,
    bringToFront,
    removeFromCanvas,
    clearCanvas,
    loadLookOntoCanvas,
    createTrip,
    deleteTrip,
    saveLook,
    deleteLook,
  };
}

export type WardrobeStore = ReturnType<typeof useWardrobeStore>;

const WardrobeStoreContext = createContext<WardrobeStore | null>(null);

/**
 * Mounted once in app/app/layout.tsx. Because that layout stays mounted
 * across client-side navigation between sibling routes (/app/wardrobe,
 * /app/trip, /app/trip/[tripId]), every page shares the same fetch,
 * realtime subscription, and in-progress canvas — switching tabs doesn't
 * lose an unsaved Mix & Match arrangement or re-fetch from scratch.
 */
export function WardrobeStoreProvider({ children }: { children: React.ReactNode }) {
  const store = useWardrobeStore();
  return <WardrobeStoreContext.Provider value={store}>{children}</WardrobeStoreContext.Provider>;
}

export function useWardrobeStoreContext(): WardrobeStore {
  const store = useContext(WardrobeStoreContext);
  if (!store) throw new Error("useWardrobeStoreContext must be used within a WardrobeStoreProvider");
  return store;
}

/* ------------------------- Shared preview block --------------------------- */

export function LookPreviewBlock({
  canvasItems,
  items,
  className,
}: {
  canvasItems: CanvasItem[];
  items: WardrobeItem[];
  className?: string;
}) {
  const itemMap = new Map(items.map((i) => [i.id, i]));

  return (
    <div
      className={`relative w-full overflow-hidden rounded-xl bg-neutral-50 ${className ?? ""}`}
      style={{ aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}
    >
      {canvasItems.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400">
          Empty look
        </div>
      )}
      {canvasItems
        .slice()
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((c) => {
          const item = itemMap.get(c.itemId);
          if (!item) return null;
          return (
            <img
              key={c.id}
              src={item.imageUrl}
              alt={item.name}
              className="absolute object-contain pointer-events-none select-none"
              style={{
                left: `${(c.x / CANVAS_WIDTH) * 100}%`,
                top: `${(c.y / CANVAS_HEIGHT) * 100}%`,
                width: `${(c.width / CANVAS_WIDTH) * 100}%`,
                height: `${(c.height / CANVAS_HEIGHT) * 100}%`,
                zIndex: c.zIndex,
              }}
            />
          );
        })}
    </div>
  );
}

/* ---------------------------------- Trips ---------------------------------- */

function TripCard({
  trip,
  looks,
  items,
  onOpen,
  onDelete,
}: {
  trip: Trip;
  looks: Look[];
  items: WardrobeItem[];
  onOpen: () => void;
  onDelete: () => void;
}) {
  const cover = looks[0];
  return (
    <div
      onClick={onOpen}
      className="group cursor-pointer rounded-2xl border border-neutral-100 hover:border-neutral-200 hover:shadow-md p-4 transition duration-200"
    >
      <LookPreviewBlock canvasItems={cover?.canvasItems ?? []} items={items} className="mb-3" />
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium text-neutral-900">{trip.name}</h3>
          <p className="text-xs text-neutral-400 mt-0.5">
            {looks.length} {looks.length === 1 ? "look" : "looks"}
          </p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete "${trip.name}"? Looks stay in your archive, just ungrouped.`)) onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 text-neutral-300 hover:text-red-500 transition duration-150 text-sm"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function TripsView({
  trips,
  looks,
  items,
  onCreateTrip,
  onOpenTrip,
  onDeleteTrip,
}: {
  trips: Trip[];
  looks: Look[];
  items: WardrobeItem[];
  onCreateTrip: (name: string) => Promise<unknown>;
  onOpenTrip: (id: string) => void;
  onDeleteTrip: (id: string) => Promise<unknown>;
}) {
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onCreateTrip(name);
      setName("");
      setShowNew(false);
    } catch (err) {
      console.error(err);
      alert("Couldn't create this trip. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await onDeleteTrip(id);
    } catch (err) {
      console.error(err);
      alert("Couldn't delete this trip. Check your connection and try again.");
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-lg font-medium text-neutral-900">Trips</h1>
          <p className="text-sm text-neutral-400 mt-1">Archived outfit looks, grouped by trip</p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 text-xs bg-neutral-900 text-white rounded-full pl-2.5 pr-3.5 py-2 hover:bg-neutral-800 transition duration-150"
        >
          <span className="text-sm leading-none">+</span> New trip
        </button>
      </div>

      {showNew && (
        <div className="mb-8 flex gap-2 max-w-md">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
            placeholder="e.g. Beach Vacation"
            className="flex-1 rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
          />
          <button
            onClick={handleCreate}
            disabled={saving}
            className="rounded-lg bg-neutral-900 text-white text-sm px-4 hover:bg-neutral-800 disabled:opacity-50 transition duration-150"
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      )}

      {trips.length === 0 ? (
        <div className="text-center text-sm text-neutral-400 py-24">
          No trips yet. Save a look from the Matcher and archive it into a new trip.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {trips.map((trip) => {
            const tripLooks = looks.filter((l) => l.tripId === trip.id);
            return (
              <TripCard
                key={trip.id}
                trip={trip}
                looks={tripLooks}
                items={items}
                onOpen={() => onOpenTrip(trip.id)}
                onDelete={() => handleDelete(trip.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TripDetailView({
  trip,
  looks,
  items,
  onBack,
  onDeleteLook,
  onEditLook,
}: {
  trip: Trip;
  looks: Look[];
  items: WardrobeItem[];
  onBack: () => void;
  onDeleteLook: (id: string) => Promise<unknown>;
  onEditLook: (look: Look) => void;
}) {
  const tripLooks = looks.filter((l) => l.tripId === trip.id);

  async function handleDelete(look: Look) {
    if (!confirm(`Delete "${look.name}"?`)) return;
    try {
      await onDeleteLook(look.id);
    } catch (err) {
      console.error(err);
      alert("Couldn't delete this look. Check your connection and try again.");
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-900 mb-6 transition duration-150"
      >
        <span>←</span> All trips
      </button>

      <h1 className="text-lg font-medium text-neutral-900 mb-1">{trip.name}</h1>
      <p className="text-sm text-neutral-400 mb-8">
        {tripLooks.length} saved {tripLooks.length === 1 ? "look" : "looks"}
      </p>

      {tripLooks.length === 0 ? (
        <div className="text-center text-sm text-neutral-400 py-24">No looks archived here yet.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {tripLooks.map((look) => (
            <div
              key={look.id}
              onClick={() => onEditLook(look)}
              className="group relative cursor-pointer rounded-2xl border border-neutral-100 hover:border-neutral-200 hover:shadow-md p-4 transition duration-200"
            >
              <LookPreviewBlock canvasItems={look.canvasItems} items={items} className="mb-3" />
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-900">{look.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(look);
                  }}
                  className="text-neutral-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition duration-150 text-sm"
                >
                  ×
                </button>
              </div>
              <div className="absolute inset-0 z-[100] rounded-2xl bg-black/0 group-hover:bg-black/40 transition duration-200 flex items-center justify-center pointer-events-none">
                <span className="px-4 py-1.5 rounded-full bg-white text-neutral-900 text-sm font-medium opacity-0 group-hover:opacity-100 transition duration-200">
                  Edit
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
