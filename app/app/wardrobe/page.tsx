"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient, WARDROBE_BUCKET } from "@/lib/supabase/client";

/* -------------------------------------------------------------------------
 * Virtual Wardrobe — /app/wardrobe
 *
 * Data model: three Postgres tables (wardrobe_items, looks, trips) plus a
 * public Storage bucket for photos, each row scoped to the signed-in user
 * via `user_id` + Row Level Security. See supabase/schema.sql for the full
 * migration.
 *
 * Access control: real Supabase Auth (email/password). Sign in/register live
 * at /auth/signin and /auth/register; middleware.ts protects everything
 * under /app (this page included) and redirects signed-out visitors to
 * /auth/signin. There's no shared password anymore — each person has their
 * own account and only ever sees their own data.
 *
 * Sync model:
 *  - Uploading a photo, categorizing it, saving a look, and archiving a
 *    trip all write straight to Supabase.
 *  - Every connected device subscribes to Postgres realtime changes on all
 *    three tables (RLS applies to realtime too, so you only ever receive
 *    your own changes), so edits on one device appear on another within a
 *    second or two, no refresh needed.
 *  - The in-progress mix & match canvas (items dragged onto the board
 *    before you hit "Save look") is local component state only — it's
 *    ephemeral by design and doesn't need to sync.
 *
 * Background removal was intentionally removed: uploaded photos are used
 * as-is (only downscaled client-side to keep files small before upload).
 * ---------------------------------------------------------------------- */

const CATEGORIES = [
  "Top",
  "Bottom",
  "Accessory",
  "Footwear",
  "Outer",
  "Swimwear",
  "Activewear",
] as const;

type Category = (typeof CATEGORIES)[number];

interface WardrobeItem {
  id: string;
  name: string;
  category: Category;
  imageUrl: string;
  imagePath: string; // storage object path ("<user_id>/<file>.png"), needed to delete the file
  createdAt: number;
}

interface CanvasItem {
  id: string;
  itemId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

interface Look {
  id: string;
  name: string;
  canvasItems: CanvasItem[];
  tripId: string | null;
  createdAt: number;
}

interface Trip {
  id: string;
  name: string;
  createdAt: number;
}

const CANVAS_WIDTH = 720;
const CANVAS_HEIGHT = 560;

/* ---------------------------- Utilities --------------------------------- */

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Downscales an upload client-side to keep storage/transfer small. Returns a Blob ready to upload. */
async function downscaleImage(file: File, maxDimension = 1000): Promise<Blob> {
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

  const addToCanvas = useCallback((itemId: string) => {
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
  }, []);

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

/* ------------------------- Shared preview block --------------------------- */

function LookPreviewBlock({
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

/* --------------------------- Canvas item (drag/resize) -------------------- */

function CanvasItemView({
  ci,
  item,
  onUpdate,
  onBringToFront,
  onRemove,
}: {
  ci: CanvasItem;
  item: WardrobeItem;
  onUpdate: (id: string, patch: Partial<CanvasItem>) => void;
  onBringToFront: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  function handleDragPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    onBringToFront(ci.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = ci.x;
    const originY = ci.y;

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      onUpdate(ci.id, {
        x: clamp(originX + dx, 0, CANVAS_WIDTH - ci.width),
        y: clamp(originY + dy, 0, CANVAS_HEIGHT - ci.height),
      });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleResizePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.preventDefault();
    onBringToFront(ci.id);
    const startX = e.clientX;
    const startW = ci.width;
    const startH = ci.height;
    const aspect = startW / startH;

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const newWidth = clamp(startW + dx, 60, 500);
      const newHeight = newWidth / aspect;
      onUpdate(ci.id, { width: newWidth, height: newHeight });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      onPointerDown={handleDragPointerDown}
      className="absolute group cursor-grab active:cursor-grabbing"
      style={{
        left: ci.x,
        top: ci.y,
        width: ci.width,
        height: ci.height,
        zIndex: ci.zIndex,
        touchAction: "none",
      }}
    >
      <img
        src={item.imageUrl}
        alt={item.name}
        draggable={false}
        className="w-full h-full object-contain select-none pointer-events-none drop-shadow-sm"
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(ci.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center bg-white border border-neutral-200 rounded-full text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-red-500 shadow-sm transition duration-150 text-xs leading-none"
      >
        ×
      </button>
      <div
        onPointerDown={handleResizePointerDown}
        className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-white border border-neutral-300 rounded-sm opacity-0 group-hover:opacity-100 cursor-nwse-resize transition duration-150"
      />
    </div>
  );
}

/* ------------------------------- Canvas panel ------------------------------ */

function MatchCanvas({
  items,
  canvasItems,
  addToCanvas,
  updateCanvasItem,
  bringToFront,
  removeFromCanvas,
  clearCanvas,
  onRequestSave,
}: {
  items: WardrobeItem[];
  canvasItems: CanvasItem[];
  addToCanvas: (itemId: string) => void;
  updateCanvasItem: (id: string, patch: Partial<CanvasItem>) => void;
  bringToFront: (id: string) => void;
  removeFromCanvas: (id: string) => void;
  clearCanvas: () => void;
  onRequestSave: () => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    const itemId = e.dataTransfer.getData("text/plain");
    if (itemId) addToCanvas(itemId);
  }

  return (
    <section className="flex-1 min-w-0 flex flex-col h-full bg-neutral-50/50">
      <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
        <div>
          <h2 className="text-sm font-medium text-neutral-900">Mix & match</h2>
          <p className="text-xs text-neutral-400 mt-0.5">
            Drag items here, then resize and arrange your look
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={clearCanvas}
            disabled={canvasItems.length === 0}
            className="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-30 disabled:hover:text-neutral-500 px-3 py-1.5 rounded-full border border-neutral-200 transition duration-150"
          >
            Clear
          </button>
          <button
            onClick={onRequestSave}
            disabled={canvasItems.length === 0}
            className="text-xs bg-neutral-900 text-white px-3.5 py-1.5 rounded-full hover:bg-neutral-800 disabled:opacity-30 transition duration-150"
          >
            Save look
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 flex items-center justify-center">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          className={`relative bg-white rounded-2xl border transition duration-200 ${
            isDragOver ? "border-neutral-900 border-2" : "border-neutral-200 border-dashed"
          }`}
          style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, maxWidth: "100%" }}
        >
          {canvasItems.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-300 pointer-events-none">
              Drop clothing items here
            </div>
          )}
          {canvasItems.map((ci) => {
            const item = itemMap.get(ci.itemId);
            if (!item) return null;
            return (
              <CanvasItemView
                key={ci.id}
                ci={ci}
                item={item}
                onUpdate={updateCanvasItem}
                onBringToFront={bringToFront}
                onRemove={removeFromCanvas}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Wardrobe panel ----------------------------- */

function WardrobePanel({
  items,
  addToCanvas,
  removeItem,
  onOpenUpload,
  activeTab,
  setActiveTab,
}: {
  items: WardrobeItem[];
  addToCanvas: (itemId: string) => void;
  removeItem: (item: WardrobeItem) => void;
  onOpenUpload: () => void;
  activeTab: Category | "All";
  setActiveTab: (c: Category | "All") => void;
}) {
  const [removingId, setRemovingId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const item of items) c[item.category] = (c[item.category] ?? 0) + 1;
    return c;
  }, [items]);

  const filtered = useMemo(
    () => (activeTab === "All" ? items : items.filter((i) => i.category === activeTab)),
    [items, activeTab]
  );

  const tabs: (Category | "All")[] = ["All", ...CATEGORIES];

  async function handleRemove(item: WardrobeItem) {
    setRemovingId(item.id);
    try {
      await removeItem(item);
    } catch (err) {
      console.error(err);
      alert("Couldn't delete this item. Check your connection and try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <aside className="w-full lg:w-[380px] shrink-0 border-l border-neutral-100 flex flex-col h-full bg-white">
      <div className="p-5 border-b border-neutral-100 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-neutral-900">Wardrobe</h2>
          <button
            onClick={onOpenUpload}
            className="flex items-center gap-1 text-xs bg-neutral-900 text-white rounded-full pl-2 pr-3 py-1.5 hover:bg-neutral-800 transition duration-150"
          >
            <span className="text-sm leading-none">+</span> Add item
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((tab) => {
            const isActive = tab === activeTab;
            const count = tab === "All" ? undefined : counts[tab];
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 text-xs rounded-full border transition duration-200 ${
                  isActive
                    ? "bg-neutral-900 text-white border-neutral-900"
                    : "bg-white text-neutral-500 border-neutral-200 hover:border-neutral-400 hover:text-neutral-900"
                }`}
              >
                {tab}
                {count ? <span className="ml-1 opacity-60">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-sm text-neutral-400 px-6">
            {items.length === 0
              ? "Your wardrobe is empty. Add your first item to get started."
              : "Nothing in this category yet."}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map((item) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", item.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => addToCanvas(item.id)}
                className="group relative rounded-xl border border-neutral-100 bg-neutral-50 aspect-square flex items-center justify-center cursor-grab active:cursor-grabbing hover:shadow-md hover:border-neutral-200 transition duration-200"
                title="Click or drag onto the canvas"
              >
                <img
                  src={item.imageUrl}
                  alt={item.name}
                  className="max-h-[80%] max-w-[80%] object-contain pointer-events-none select-none"
                  draggable={false}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(item);
                  }}
                  disabled={removingId === item.id}
                  className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-white/90 rounded-full text-neutral-400 hover:text-red-500 disabled:opacity-50 transition duration-150 text-xs leading-none"
                >
                  ×
                </button>
                <span className="absolute bottom-1.5 left-1.5 right-1.5 text-[10px] text-neutral-500 truncate bg-white/80 rounded px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition duration-150">
                  {item.name}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/* -------------------------------- Upload modal ----------------------------- */

function UploadModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (data: { name: string; category: Category; blob: Blob }) => Promise<unknown>;
}) {
  const [stage, setStage] = useState<"select" | "review">("select");
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("Top");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function handleFile(file: File) {
    setError(null);
    try {
      const blob = await downscaleImage(file);
      setPreviewBlob(blob);
      setPreviewUrl(URL.createObjectURL(blob));
      setName(file.name.replace(/\.[^/.]+$/, ""));
      setStage("review");
    } catch (err) {
      console.error(err);
      setError("Couldn't read that image. Try another file.");
      setStage("select");
    }
  }

  async function handleSave() {
    if (!previewBlob) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd({ name: name.trim() || "New item", category, blob: previewBlob });
      onClose();
    } catch (err) {
      console.error(err);
      setError("Couldn't save this item. Check your connection and try again.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm px-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-neutral-100 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-medium text-neutral-900">Add clothing item</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-900 transition duration-150 text-lg leading-none">
            ×
          </button>
        </div>

        {stage === "select" && (
          <label className="flex flex-col items-center justify-center gap-2 border border-dashed border-neutral-300 rounded-xl h-48 cursor-pointer hover:border-neutral-500 hover:bg-neutral-50 transition duration-200">
            <span className="text-sm text-neutral-500">Click to upload a photo</span>
            <span className="text-xs text-neutral-400">You&apos;ll pick a category next</span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </label>
        )}

        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}

        {stage === "review" && previewUrl && (
          <div className="space-y-4">
            <div className="h-48 rounded-xl border border-neutral-100 flex items-center justify-center bg-neutral-50">
              <img src={previewUrl} alt="preview" className="max-h-44 max-w-full object-contain" />
            </div>

            <div>
              <label className="text-xs text-neutral-500 mb-1 block">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
                placeholder="e.g. White linen shirt"
              />
            </div>

            <div>
              <label className="text-xs text-neutral-500 mb-1 block">Category</label>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    onClick={() => setCategory(c)}
                    className={`px-3 py-1 text-xs rounded-full border transition duration-150 ${
                      category === c
                        ? "bg-neutral-900 text-white border-neutral-900"
                        : "bg-white text-neutral-500 border-neutral-200 hover:border-neutral-400"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full rounded-lg bg-neutral-900 text-white text-sm py-2.5 hover:bg-neutral-800 disabled:opacity-50 transition duration-150"
            >
              {saving ? "Adding…" : "Add to wardrobe"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- Save look modal --------------------------- */

function SaveLookModal({
  trips,
  onClose,
  onSave,
}: {
  trips: Trip[];
  onClose: () => void;
  onSave: (name: string, tripId: string | null, newTripName?: string) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [tripMode, setTripMode] = useState<"none" | "existing" | "new">(
    trips.length > 0 ? "existing" : "new"
  );
  const [tripId, setTripId] = useState(trips[0]?.id ?? "");
  const [newTripName, setNewTripName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave(name, tripMode === "existing" ? tripId : null, tripMode === "new" ? newTripName : undefined);
      onClose();
    } catch (err) {
      console.error(err);
      setError("Couldn't save this look. Check your connection and try again.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl border border-neutral-100 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-medium text-neutral-900">Save this look</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-900 transition duration-150 text-lg leading-none">
            ×
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-neutral-500 mb-1 block">Look name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rainy day in Kyoto"
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
            />
          </div>

          <div>
            <label className="text-xs text-neutral-500 mb-1 block">Archive to a trip</label>
            <div className="flex gap-1.5 mb-2">
              <button
                onClick={() => setTripMode("existing")}
                disabled={trips.length === 0}
                className={`flex-1 text-xs py-1.5 rounded-full border transition duration-150 disabled:opacity-30 ${
                  tripMode === "existing" ? "bg-neutral-900 text-white border-neutral-900" : "border-neutral-200 text-neutral-500"
                }`}
              >
                Existing trip
              </button>
              <button
                onClick={() => setTripMode("new")}
                className={`flex-1 text-xs py-1.5 rounded-full border transition duration-150 ${
                  tripMode === "new" ? "bg-neutral-900 text-white border-neutral-900" : "border-neutral-200 text-neutral-500"
                }`}
              >
                New trip
              </button>
              <button
                onClick={() => setTripMode("none")}
                className={`flex-1 text-xs py-1.5 rounded-full border transition duration-150 ${
                  tripMode === "none" ? "bg-neutral-900 text-white border-neutral-900" : "border-neutral-200 text-neutral-500"
                }`}
              >
                None
              </button>
            </div>

            {tripMode === "existing" && (
              <select
                value={tripId}
                onChange={(e) => setTripId(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
              >
                {trips.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}

            {tripMode === "new" && (
              <input
                value={newTripName}
                onChange={(e) => setNewTripName(e.target.value)}
                placeholder="e.g. Trip to Japan 2026"
                className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
              />
            )}
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full rounded-lg bg-neutral-900 text-white text-sm py-2.5 hover:bg-neutral-800 disabled:opacity-50 transition duration-150"
          >
            {saving ? "Saving…" : "Save look"}
          </button>
        </div>
      </div>
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

function TripsView({
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

function TripDetailView({
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
              className="group rounded-2xl border border-neutral-100 hover:border-neutral-200 hover:shadow-md p-4 transition duration-200"
            >
              <LookPreviewBlock canvasItems={look.canvasItems} items={items} className="mb-3" />
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-900">{look.name}</span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => onEditLook(look)}
                    className="text-xs text-neutral-400 hover:text-neutral-900 opacity-0 group-hover:opacity-100 transition duration-150"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(look)}
                    className="text-neutral-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition duration-150 text-sm"
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------- Page ----------------------------------- */

function tabClass(active: boolean): string {
  return `px-3 py-1.5 text-sm rounded-full transition duration-200 ${
    active ? "bg-neutral-900 text-white" : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
  }`;
}

export default function WardrobePage() {
  const store = useWardrobeStore();
  const router = useRouter();
  const [view, setView] = useState<"matcher" | "trips">("matcher");
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [categoryTab, setCategoryTab] = useState<Category | "All">("All");
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/auth/signin");
    router.refresh();
  }

  if (store.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-neutral-400">
        Loading…
      </div>
    );
  }

  if (store.error) {
    return (
      <div className="min-h-screen flex items-center justify-center text-center px-6">
        <div>
          <p className="text-sm text-neutral-900 mb-1">Couldn&apos;t load your wardrobe</p>
          <p className="text-xs text-neutral-400">{store.error}</p>
        </div>
      </div>
    );
  }

  const selectedTrip = selectedTripId ? store.trips.find((t) => t.id === selectedTripId) ?? null : null;

  return (
    <div className="min-h-screen bg-white text-neutral-900 flex flex-col">
      <header className="border-b border-neutral-100 px-6 py-4 flex items-center justify-between shrink-0">
        <span className="text-[15px] font-medium tracking-tight">Wardrobe</span>
        <nav className="flex items-center gap-1">
          <button onClick={() => setView("matcher")} className={tabClass(view === "matcher")}>
            Matcher
          </button>
          <button
            onClick={() => {
              setView("trips");
              setSelectedTripId(null);
            }}
            className={tabClass(view === "trips")}
          >
            Trips
          </button>
          <button
            onClick={handleLogout}
            disabled={signingOut}
            className="ml-2 px-3 py-1.5 text-sm rounded-full text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 disabled:opacity-50 transition duration-200"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </nav>
      </header>

      <main className="flex-1 min-h-0">
        {view === "matcher" ? (
          <div className="flex flex-col lg:flex-row h-[calc(100vh-65px)]">
            <MatchCanvas
              items={store.items}
              canvasItems={store.canvasItems}
              addToCanvas={store.addToCanvas}
              updateCanvasItem={store.updateCanvasItem}
              bringToFront={store.bringToFront}
              removeFromCanvas={store.removeFromCanvas}
              clearCanvas={store.clearCanvas}
              onRequestSave={() => setShowSave(true)}
            />
            <WardrobePanel
              items={store.items}
              addToCanvas={store.addToCanvas}
              removeItem={store.removeItem}
              onOpenUpload={() => setShowUpload(true)}
              activeTab={categoryTab}
              setActiveTab={setCategoryTab}
            />
          </div>
        ) : selectedTrip ? (
          <TripDetailView
            trip={selectedTrip}
            looks={store.looks}
            items={store.items}
            onBack={() => setSelectedTripId(null)}
            onDeleteLook={store.deleteLook}
            onEditLook={(look) => {
              store.loadLookOntoCanvas(look);
              setView("matcher");
            }}
          />
        ) : (
          <TripsView
            trips={store.trips}
            looks={store.looks}
            items={store.items}
            onCreateTrip={store.createTrip}
            onOpenTrip={(id) => setSelectedTripId(id)}
            onDeleteTrip={store.deleteTrip}
          />
        )}
      </main>

      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onAdd={store.addItem} />}
      {showSave && (
        <SaveLookModal
          trips={store.trips}
          onClose={() => setShowSave(false)}
          onSave={(name, tripId, newTripName) => store.saveLook(store.canvasItems, name, tripId, newTripName)}
        />
      )}
    </div>
  );
}
