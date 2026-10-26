"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
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
  "Set",
  "Full Body",
  "Accessory",
  "Bag",
  "Footwear",
  "Outer",
  "Swimwear",
  "Activewear",
] as const;

export type Category = (typeof CATEGORIES)[number];

// The exact set of selectable item colors. "All" is a filter-only reset
// option, never a real item's color — see COLOR_FILTER_OPTIONS below.
export const COLORS = [
  "White",
  "Black",
  "Ivory",
  "Beige",
  "Brown",
  "Grey",
  "Yellow",
  "Orange",
  "Red",
  "Green",
  "Navy",
  "Blue",
  "Denim",
  "Pink",
  "Purple",
  "Lilac",
  "Mint",
  "Turquoise",
  "Lemon",
  "Gold",
  "Silver",
  "Glitter",
  "Multi-color",
] as const;

export type WardrobeColor = (typeof COLORS)[number];

export const COLOR_FILTER_OPTIONS = ["All", ...COLORS] as const;

export interface WardrobeItem {
  id: string;
  name: string;
  category: Category;
  color: WardrobeColor | null; // null only for items uploaded before this field existed
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
  position: number | null; // manual order within its trip; null until first reordered
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
    color: (row.color as WardrobeColor | null) ?? null,
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
    position: row.position ?? null,
    createdAt: new Date(row.created_at).getTime(),
  };
}

// Display order for a trip's looks. Looks dragged into place carry a
// position; ones saved since (position null) stay on top, newest first —
// the same order as before reordering existed.
function sortLooks(looks: Look[]): Look[] {
  return [...looks].sort((a, b) => {
    if (a.position === null && b.position === null) return b.createdAt - a.createdAt;
    if (a.position === null) return -1;
    if (b.position === null) return 1;
    return a.position - b.position;
  });
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
  // Name of the look currently on the canvas. Lives next to canvasItems so it
  // survives navigating to Trips and back, and resets whenever the canvas does.
  const [lookName, setLookName] = useState("");
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
    async (data: { name: string; category: Category; color: WardrobeColor; blob: Blob }) => {
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
        .insert({
          name: data.name,
          category: data.category,
          color: data.color,
          image_url: publicUrl,
          image_path: path,
        })
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

  const updateItem = useCallback(
    async (
      item: WardrobeItem,
      data: { name: string; category: Category; color: WardrobeColor; newImageBlob?: Blob }
    ) => {
      let imageUrl = item.imageUrl;
      let imagePath = item.imagePath;

      if (data.newImageBlob) {
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (userError || !userData.user) {
          throw new Error("You're not signed in. Please sign in again.");
        }

        const newPath = `${userData.user.id}/${makeId()}.png`;
        const { error: uploadError } = await supabase.storage
          .from(WARDROBE_BUCKET)
          .upload(newPath, data.newImageBlob, { contentType: "image/png", upsert: false });
        if (uploadError) throw uploadError;

        const {
          data: { publicUrl },
        } = supabase.storage.from(WARDROBE_BUCKET).getPublicUrl(newPath);

        // Best-effort cleanup of the old photo — don't fail the whole save
        // over it if it doesn't go through.
        supabase.storage
          .from(WARDROBE_BUCKET)
          .remove([item.imagePath])
          .then(({ error }) => {
            if (error) console.error("Couldn't remove replaced item photo:", error);
          });

        imageUrl = publicUrl;
        imagePath = newPath;
      }

      const { error: updateError } = await supabase
        .from("wardrobe_items")
        .update({ name: data.name, category: data.category, color: data.color, image_url: imageUrl, image_path: imagePath })
        .eq("id", item.id);
      if (updateError) throw updateError;

      setItems((s) =>
        s.map((i) =>
          i.id === item.id
            ? { ...i, name: data.name, category: data.category, color: data.color, imageUrl, imagePath }
            : i
        )
      );
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

  const clearCanvas = useCallback(() => {
    setCanvasItems([]);
    setLookName("");
  }, []);

  const loadLookOntoCanvas = useCallback((look: Look) => {
    setCanvasItems(look.canvasItems.map((c) => ({ ...c, id: makeId() })));
    setLookName(look.name);
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

  // Overwrites an existing look's canvas arrangement (and name, when given)
  // in place — used when re-editing a look from Trips — instead of inserting
  // a new row.
  const updateLook = useCallback(
    async (id: string, currentCanvasItems: CanvasItem[], name?: string) => {
      const trimmedName = name?.trim();
      const { error: updateError } = await supabase
        .from("looks")
        .update(
          trimmedName
            ? { canvas_items: currentCanvasItems, name: trimmedName }
            : { canvas_items: currentCanvasItems }
        )
        .eq("id", id);
      if (updateError) throw updateError;
      setLooks((s) =>
        s.map((l) =>
          l.id === id
            ? { ...l, canvasItems: currentCanvasItems, ...(trimmedName ? { name: trimmedName } : {}) }
            : l
        )
      );
    },
    [supabase]
  );

  const deleteLook = useCallback(
    async (id: string) => {
      const { error: deleteError } = await supabase.from("looks").delete().eq("id", id);
      if (deleteError) throw deleteError;
      setLooks((s) => s.filter((l) => l.id !== id));
    },
    [supabase]
  );

  // Persists a trip's new look order (ids in display order). Applied
  // optimistically so the dropped card stays put; rolled back on failure.
  const reorderLooks = useCallback(
    async (orderedIds: string[]) => {
      const positions = new Map(orderedIds.map((id, i) => [id, i]));
      // Filled in by the updater, which has always run by the time the
      // network round-trip below resolves.
      const previousPositions = new Map<string, number | null>();
      setLooks((s) =>
        s.map((l) => {
          if (!positions.has(l.id)) return l;
          previousPositions.set(l.id, l.position);
          return { ...l, position: positions.get(l.id)! };
        })
      );
      const results = await Promise.all(
        orderedIds.map((id, i) => supabase.from("looks").update({ position: i }).eq("id", id))
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) {
        setLooks((s) =>
          s.map((l) => (previousPositions.has(l.id) ? { ...l, position: previousPositions.get(l.id)! } : l))
        );
        throw failed.error;
      }
    },
    [supabase]
  );

  return {
    items,
    looks,
    trips,
    canvasItems,
    lookName,
    setLookName,
    loading,
    error,
    addItem,
    removeItem,
    updateItem,
    addToCanvas,
    updateCanvasItem,
    bringToFront,
    removeFromCanvas,
    clearCanvas,
    loadLookOntoCanvas,
    createTrip,
    deleteTrip,
    saveLook,
    updateLook,
    deleteLook,
    reorderLooks,
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
            <div
              key={c.id}
              className="absolute"
              style={{
                left: `${(c.x / CANVAS_WIDTH) * 100}%`,
                top: `${(c.y / CANVAS_HEIGHT) * 100}%`,
                width: `${(c.width / CANVAS_WIDTH) * 100}%`,
                height: `${(c.height / CANVAS_HEIGHT) * 100}%`,
                zIndex: c.zIndex,
              }}
            >
              <Image
                src={item.imageUrl}
                alt={item.name}
                fill
                sizes="200px"
                className="object-contain pointer-events-none select-none"
              />
            </div>
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
      className="group relative cursor-pointer rounded-2xl border border-neutral-100 sm:hover:border-neutral-200 sm:hover:shadow-md p-4 transition duration-200"
    >
      <LookPreviewBlock canvasItems={cover?.canvasItems ?? []} items={items} className="mb-3" />
      <div>
        <h3 className="text-sm font-medium text-neutral-900">{trip.name}</h3>
        <p className="text-xs text-neutral-400 mt-0.5">
          {looks.length} {looks.length === 1 ? "look" : "looks"}
        </p>
      </div>

      {/* z-[9999]: the cover look's item images carry their own explicit
          z-index (unbounded — it grows every time an item is dragged or
          resized on the canvas), which otherwise renders above these
          buttons and swallows their clicks regardless of DOM order. */}
      <div className="absolute top-4 right-4 z-[9999] flex flex-col gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title="Edit"
          className="hidden sm:flex sm:opacity-0 sm:group-hover:opacity-100 w-7 h-7 items-center justify-center rounded-full bg-white/90 border border-neutral-200 text-neutral-500 hover:text-neutral-900 shadow-sm transition duration-150 text-xs leading-none"
        >
          ✎
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete "${trip.name}"? Looks stay in your archive, just ungrouped.`)) onDelete();
          }}
          title="Delete"
          className="flex sm:opacity-0 sm:group-hover:opacity-100 w-7 h-7 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-800 shadow-sm transition duration-150 text-xs leading-none"
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
            // Sorted so the cover is the first look in the trip's own order.
            const tripLooks = sortLooks(looks.filter((l) => l.tripId === trip.id));
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
  onReorderLooks,
}: {
  trip: Trip;
  looks: Look[];
  items: WardrobeItem[];
  onBack: () => void;
  onDeleteLook: (id: string) => Promise<unknown>;
  onEditLook: (look: Look) => void;
  onReorderLooks: (orderedIds: string[]) => Promise<unknown>;
}) {
  const sortedLooks = sortLooks(looks.filter((l) => l.tripId === trip.id));
  // While a drag is in progress the grid renders this local order instead,
  // so cards shuffle live under the pointer without touching the store.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Width of the floating copy that follows the pointer; null when idle.
  const [floatWidth, setFloatWidth] = useState<number | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const gridRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  // The floating copy's position is written straight to its style on every
  // pointer move (not via state) so dragging doesn't re-render the page.
  const floatPos = useRef({ x: 0, y: 0 });
  // On-screen rect of every card just before a reorder, for the FLIP slide.
  const prevRects = useRef(new Map<string, DOMRect>());
  const lookById = new Map(sortedLooks.map((l) => [l.id, l]));
  const tripLooks = dragOrder
    ? dragOrder.map((id) => lookById.get(id)).filter((l): l is Look => !!l)
    : sortedLooks;
  const draggingLook = draggingId ? lookById.get(draggingId) ?? null : null;

  useLayoutEffect(() => {
    const el = floatRef.current;
    if (el) el.style.transform = floatTransform(floatPos.current.x, floatPos.current.y);
  }, [floatWidth]);

  // FLIP: after the grid re-renders in a new order, start each moved card at
  // its old on-screen spot and let it transition into its new slot, instead
  // of jumping there.
  useLayoutEffect(() => {
    const prev = prevRects.current;
    if (prev.size === 0) return;
    prevRects.current = new Map();
    for (const [id, el] of cardRefs.current) {
      const from = prev.get(id);
      if (!from) continue;
      el.style.transition = "none";
      el.style.transform = "";
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (!dx && !dy) continue;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.getBoundingClientRect(); // commit the start position before animating
      el.style.transition = `transform ${DRAG_SLIDE_MS}ms ${DRAG_EASE}`;
      el.style.transform = "";
      el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
    }
  }, [dragOrder]);

  // Drag starts from the handle only (touch-action: none there), so tapping
  // a card still opens it and swiping elsewhere still scrolls on mobile.
  function handleGripPointerDown(e: React.PointerEvent<HTMLButtonElement>, lookId: string) {
    if (draggingId) return; // previous drop still settling
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const card = cardRefs.current.get(lookId);
    const grid = gridRef.current;
    if (!card || !grid) return;

    const initialOrder = sortedLooks.map((l) => l.id);
    let order = initialOrder;
    let lastX = e.clientX;
    let lastY = e.clientY;
    const cardBox = card.getBoundingClientRect();
    const grabX = e.clientX - cardBox.left;
    const grabY = e.clientY - cardBox.top;

    // Grid slots never move during a drag (same cards, same grid) — only
    // which look sits in each one changes — so hit-testing against these
    // fixed slots can't flicker back and forth while cards are sliding.
    const gridBox = grid.getBoundingClientRect();
    const slots = initialOrder.map((id) => {
      const r = cardRefs.current.get(id)!.getBoundingClientRect();
      return {
        left: r.left - gridBox.left,
        top: r.top - gridBox.top,
        right: r.right - gridBox.left,
        bottom: r.bottom - gridBox.top,
      };
    });

    floatPos.current = { x: cardBox.left, y: cardBox.top };
    setFloatWidth(cardBox.width);
    setDragOrder(order);
    setDraggingId(lookId);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    function moveFloat() {
      floatPos.current = { x: lastX - grabX, y: lastY - grabY };
      const el = floatRef.current;
      if (el) el.style.transform = floatTransform(floatPos.current.x, floatPos.current.y);
    }

    function reorderUnderPointer() {
      const g = gridRef.current?.getBoundingClientRect();
      if (!g) return;
      const x = lastX - g.left;
      const y = lastY - g.top;
      const target = slots.findIndex((s) => x >= s.left && x <= s.right && y >= s.top && y <= s.bottom);
      if (target === -1 || target === order.indexOf(lookId)) return;
      const next = order.filter((id) => id !== lookId);
      next.splice(target, 0, lookId);
      const rects = new Map<string, DOMRect>();
      for (const [id, el] of cardRefs.current) rects.set(id, el.getBoundingClientRect());
      prevRects.current = rects;
      order = next;
      setDragOrder(order);
    }

    // Trips pages scroll inside <main> (see app/app/layout.tsx), not the
    // window — nudge it while the pointer sits near its top/bottom edge.
    const scroller = e.currentTarget.closest("main");
    let frame = requestAnimationFrame(function autoScroll() {
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        const before = scroller.scrollTop;
        if (lastY < r.top + 64) scroller.scrollTop -= 12;
        else if (lastY > r.bottom - 64) scroller.scrollTop += 12;
        if (scroller.scrollTop !== before) reorderUnderPointer();
      }
      frame = requestAnimationFrame(autoScroll);
    });

    function onMove(ev: PointerEvent) {
      lastX = ev.clientX;
      lastY = ev.clientY;
      moveFloat();
      reorderUnderPointer();
    }
    function onUp() {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (order.some((id, i) => id !== initialOrder[i])) {
        // reorderLooks updates the store synchronously before its network
        // call, so clearing dragOrder below doesn't flash the old order.
        onReorderLooks(order).catch((err) => {
          console.error(err);
          alert("Couldn't save the new order. Check your connection and try again.");
        });
      }
      // Glide the floating copy into the card's final slot, then drop it.
      const slot = cardRefs.current.get(lookId)?.getBoundingClientRect();
      const el = floatRef.current;
      if (slot && el) {
        el.style.transition = `transform ${DRAG_DROP_MS}ms ${DRAG_EASE}, box-shadow ${DRAG_DROP_MS}ms`;
        el.style.transform = `translate3d(${slot.left}px, ${slot.top}px, 0)`;
        el.style.boxShadow = "none";
      }
      window.setTimeout(() => {
        setDraggingId(null);
        setDragOrder(null);
        setFloatWidth(null);
      }, DRAG_DROP_MS);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  async function handleDelete(look: Look) {
    if (!confirm(`Are you sure you want to delete "${look.name}"? This action cannot be undone.`)) return;
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
        <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {tripLooks.map((look) => (
            <div
              key={look.id}
              ref={(el) => {
                if (el) cardRefs.current.set(look.id, el);
                else cardRefs.current.delete(look.id);
              }}
              onClick={() => onEditLook(look)}
              className={`group relative cursor-pointer rounded-2xl border p-4 transition duration-200 ${
                draggingId === look.id
                  ? // Empty slot marking where the floating card will land.
                    "border-dashed border-neutral-300 bg-neutral-50 [&>*]:invisible"
                  : "border-neutral-100 sm:hover:border-neutral-200 sm:hover:shadow-md"
              }`}
            >
              <LookPreviewBlock canvasItems={look.canvasItems} items={items} className="mb-3" />
              <span className="text-sm text-neutral-900">{look.name}</span>

              {/* Same z-[9999] reasoning as the Edit/Delete column below.
                  Hidden until hover only with a mouse/trackpad
                  (pointer-fine) — phones and iPads have no hover, so it
                  always shows there regardless of screen width. */}
              <div className="absolute top-4 left-4 z-[9999]">
                <button
                  onPointerDown={(e) => handleGripPointerDown(e, look.id)}
                  onClick={(e) => e.stopPropagation()}
                  title="Drag to reorder"
                  style={{ touchAction: "none" }}
                  className={`${GRIP_CLASS} pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 cursor-grab`}
                >
                  <GripIcon />
                </button>
              </div>

              {/* z-[9999]: LookPreviewBlock's item images carry their own
                  explicit z-index (unbounded — it grows every time an item
                  is dragged or resized on the canvas), which otherwise
                  renders above these buttons and swallows their clicks
                  regardless of DOM order. */}
              <div className="absolute top-4 right-4 z-[9999] flex flex-col gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditLook(look);
                  }}
                  title="Edit"
                  className="hidden sm:flex sm:opacity-0 sm:group-hover:opacity-100 w-7 h-7 items-center justify-center rounded-full bg-white/90 border border-neutral-200 text-neutral-500 hover:text-neutral-900 shadow-sm transition duration-150 text-xs leading-none"
                >
                  ✎
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(look);
                  }}
                  title="Delete"
                  className="flex sm:opacity-0 sm:group-hover:opacity-100 w-7 h-7 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-800 shadow-sm transition duration-150 text-xs leading-none"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Floating copy of the dragged card. position: fixed so it tracks the
          pointer in viewport coordinates even while <main> auto-scrolls;
          its transform is set imperatively (see floatPos). */}
      {draggingLook && floatWidth !== null && (
        <div
          ref={floatRef}
          className="fixed left-0 top-0 z-[10000] pointer-events-none rounded-2xl border border-neutral-200 bg-white p-4 shadow-2xl"
          style={{ width: floatWidth, willChange: "transform" }}
        >
          <LookPreviewBlock canvasItems={draggingLook.canvasItems} items={items} className="mb-3" />
          <span className="text-sm text-neutral-900">{draggingLook.name}</span>
          <div className="absolute top-4 left-4 z-[9999]">
            <div className={GRIP_CLASS}>
              <GripIcon />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const DRAG_SLIDE_MS = 220;
const DRAG_DROP_MS = 180;
const DRAG_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

const GRIP_CLASS =
  "flex w-7 h-7 items-center justify-center rounded-full bg-white/90 border border-neutral-200 text-neutral-500 hover:text-neutral-900 shadow-sm transition duration-150";

// Slight lift while dragging so the card reads as picked up.
function floatTransform(x: number, y: number): string {
  return `translate3d(${x}px, ${y}px, 0) scale(1.03)`;
}

function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <circle cx="2.5" cy="2.5" r="1.25" />
      <circle cx="7.5" cy="2.5" r="1.25" />
      <circle cx="2.5" cy="7" r="1.25" />
      <circle cx="7.5" cy="7" r="1.25" />
      <circle cx="2.5" cy="11.5" r="1.25" />
      <circle cx="7.5" cy="11.5" r="1.25" />
    </svg>
  );
}
