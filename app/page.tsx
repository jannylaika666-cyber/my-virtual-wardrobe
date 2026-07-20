"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/* -------------------------------------------------------------------------
 * Virtual Wardrobe — single-file implementation
 *
 * Everything (types, persistence, the mix & match canvas, and trip
 * archiving) lives in this one page component so it can be dropped straight
 * into a fresh `create-next-app` project. No extra dependencies required
 * beyond React + Tailwind, both of which the default template already
 * includes.
 *
 * Uploaded photos are used as-is (downscaled only, to keep localStorage
 * small) — there is no background removal step. Users categorize the item
 * immediately after upload.
 *
 * State persists to localStorage, so this works with zero backend. Swap
 * `useWardrobeStore` for real API calls later without touching the UI —
 * every component below only talks to the store through the actions it
 * returns.
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
  imageUrl: string; // data URL, background removed
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
  createdAt: number;
}

interface Trip {
  id: string;
  name: string;
  createdAt: number;
  lookIds: string[];
}

const CANVAS_WIDTH = 720;
const CANVAS_HEIGHT = 560;
const STORAGE_KEY = "virtual-wardrobe-v1";

/* ---------------------------- Utilities --------------------------------- */

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Downscales an upload to keep localStorage-persisted state small. */
async function fileToDataUrl(file: File, maxDimension = 1000): Promise<string> {
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
  return canvas.toDataURL("image/png");
}

/* ------------------------------ Store ------------------------------------ */

interface StoreState {
  items: WardrobeItem[];
  canvasItems: CanvasItem[];
  looks: Look[];
  trips: Trip[];
}

const EMPTY_STATE: StoreState = { items: [], canvasItems: [], looks: [], trips: [] };

function useWardrobeStore() {
  const [state, setState] = useState<StoreState>(EMPTY_STATE);
  const [hydrated, setHydrated] = useState(false);

  // Load persisted state once on mount (client only).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setState(JSON.parse(raw) as StoreState);
    } catch (err) {
      console.warn("Couldn't read saved wardrobe data.", err);
    }
    setHydrated(true);
  }, []);

  // Persist on every change, once hydrated.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn("Couldn't save wardrobe data.", err);
    }
  }, [state, hydrated]);

  const addItem = useCallback((data: Omit<WardrobeItem, "id" | "createdAt">) => {
    const newItem: WardrobeItem = { ...data, id: makeId(), createdAt: Date.now() };
    setState((s) => ({ ...s, items: [newItem, ...s.items] }));
    return newItem;
  }, []);

  const removeItem = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      items: s.items.filter((i) => i.id !== id),
      canvasItems: s.canvasItems.filter((c) => c.itemId !== id),
    }));
  }, []);

  const addToCanvas = useCallback((itemId: string) => {
    setState((s) => {
      const maxZ = s.canvasItems.reduce((m, c) => Math.max(m, c.zIndex), 0);
      const offset = (s.canvasItems.length % 6) * 14;
      const newCanvasItem: CanvasItem = {
        id: makeId(),
        itemId,
        x: 40 + offset,
        y: 40 + offset,
        width: 200,
        height: 200,
        zIndex: maxZ + 1,
      };
      return { ...s, canvasItems: [...s.canvasItems, newCanvasItem] };
    });
  }, []);

  const updateCanvasItem = useCallback((id: string, patch: Partial<CanvasItem>) => {
    setState((s) => ({
      ...s,
      canvasItems: s.canvasItems.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  }, []);

  const bringToFront = useCallback((id: string) => {
    setState((s) => {
      const maxZ = s.canvasItems.reduce((m, c) => Math.max(m, c.zIndex), 0);
      return {
        ...s,
        canvasItems: s.canvasItems.map((c) => (c.id === id ? { ...c, zIndex: maxZ + 1 } : c)),
      };
    });
  }, []);

  const removeFromCanvas = useCallback((id: string) => {
    setState((s) => ({ ...s, canvasItems: s.canvasItems.filter((c) => c.id !== id) }));
  }, []);

  const clearCanvas = useCallback(() => {
    setState((s) => ({ ...s, canvasItems: [] }));
  }, []);

  const loadLookOntoCanvas = useCallback((lookId: string) => {
    setState((s) => {
      const look = s.looks.find((l) => l.id === lookId);
      if (!look) return s;
      return { ...s, canvasItems: look.canvasItems.map((c) => ({ ...c, id: makeId() })) };
    });
  }, []);

  const saveLook = useCallback((name: string, tripId: string | null, newTripName?: string) => {
    setState((s) => {
      if (s.canvasItems.length === 0) return s;

      const look: Look = {
        id: makeId(),
        name: name.trim() || "Untitled look",
        canvasItems: s.canvasItems,
        createdAt: Date.now(),
      };

      let trips = s.trips;
      let finalTripId = tripId;

      if (!finalTripId && newTripName && newTripName.trim()) {
        const newTrip: Trip = {
          id: makeId(),
          name: newTripName.trim(),
          createdAt: Date.now(),
          lookIds: [],
        };
        trips = [newTrip, ...trips];
        finalTripId = newTrip.id;
      }

      if (finalTripId) {
        trips = trips.map((t) =>
          t.id === finalTripId ? { ...t, lookIds: [look.id, ...t.lookIds] } : t
        );
      }

      return { ...s, looks: [look, ...s.looks], trips };
    });
  }, []);

  const createTrip = useCallback((name: string) => {
    const trip: Trip = { id: makeId(), name: name.trim() || "Untitled trip", createdAt: Date.now(), lookIds: [] };
    setState((s) => ({ ...s, trips: [trip, ...s.trips] }));
    return trip;
  }, []);

  const deleteTrip = useCallback((id: string) => {
    setState((s) => ({ ...s, trips: s.trips.filter((t) => t.id !== id) }));
  }, []);

  const deleteLook = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      looks: s.looks.filter((l) => l.id !== id),
      trips: s.trips.map((t) => ({ ...t, lookIds: t.lookIds.filter((lid) => lid !== id) })),
    }));
  }, []);

  return {
    ...state,
    hydrated,
    addItem,
    removeItem,
    addToCanvas,
    updateCanvasItem,
    bringToFront,
    removeFromCanvas,
    clearCanvas,
    loadLookOntoCanvas,
    saveLook,
    createTrip,
    deleteTrip,
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
  removeItem: (id: string) => void;
  onOpenUpload: () => void;
  activeTab: Category | "All";
  setActiveTab: (c: Category | "All") => void;
}) {
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
                    removeItem(item.id);
                  }}
                  className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-white/90 rounded-full text-neutral-400 hover:text-red-500 transition duration-150 text-xs leading-none"
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
  onAdd: (data: { name: string; category: Category; imageUrl: string }) => void;
}) {
  const [stage, setStage] = useState<"select" | "review">("select");
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("Top");
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      setPreview(dataUrl);
      setName(file.name.replace(/\.[^/.]+$/, ""));
      setStage("review");
    } catch (err) {
      console.error(err);
      setError("Couldn't read that image. Try another file.");
      setStage("select");
    }
  }

  function handleSave() {
    if (!preview) return;
    onAdd({ name: name.trim() || "New item", category, imageUrl: preview });
    onClose();
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
            <span className="text-xs text-neutral-400">You'll pick a category next</span>
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

        {stage === "review" && preview && (
          <div className="space-y-4">
            <div className="h-48 rounded-xl border border-neutral-100 flex items-center justify-center bg-neutral-50">
              <img src={preview} alt="preview" className="max-h-44 max-w-full object-contain" />
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
              className="w-full rounded-lg bg-neutral-900 text-white text-sm py-2.5 hover:bg-neutral-800 transition duration-150"
            >
              Add to wardrobe
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
  onSave: (name: string, tripId: string | null, newTripName?: string) => void;
}) {
  const [name, setName] = useState("");
  const [tripMode, setTripMode] = useState<"none" | "existing" | "new">(
    trips.length > 0 ? "existing" : "new"
  );
  const [tripId, setTripId] = useState(trips[0]?.id ?? "");
  const [newTripName, setNewTripName] = useState("");

  function handleSave() {
    onSave(name, tripMode === "existing" ? tripId : null, tripMode === "new" ? newTripName : undefined);
    onClose();
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

          <button
            onClick={handleSave}
            className="w-full rounded-lg bg-neutral-900 text-white text-sm py-2.5 hover:bg-neutral-800 transition duration-150"
          >
            Save look
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
            if (confirm(`Delete "${trip.name}"? Looks stay in your archive.`)) onDelete();
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
  onCreateTrip: (name: string) => void;
  onOpenTrip: (id: string) => void;
  onDeleteTrip: (id: string) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const lookMap = useMemo(() => new Map(looks.map((l) => [l.id, l])), [looks]);

  function handleCreate() {
    if (!name.trim()) return;
    onCreateTrip(name);
    setName("");
    setShowNew(false);
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
            className="rounded-lg bg-neutral-900 text-white text-sm px-4 hover:bg-neutral-800 transition duration-150"
          >
            Create
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
            const tripLooks = trip.lookIds
              .map((id) => lookMap.get(id))
              .filter((l): l is Look => Boolean(l));
            return (
              <TripCard
                key={trip.id}
                trip={trip}
                looks={tripLooks}
                items={items}
                onOpen={() => onOpenTrip(trip.id)}
                onDelete={() => onDeleteTrip(trip.id)}
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
  onDeleteLook: (id: string) => void;
  onEditLook: (id: string) => void;
}) {
  const tripLooks = trip.lookIds
    .map((id) => looks.find((l) => l.id === id))
    .filter((l): l is Look => Boolean(l));

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
                    onClick={() => onEditLook(look.id)}
                    className="text-xs text-neutral-400 hover:text-neutral-900 opacity-0 group-hover:opacity-100 transition duration-150"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${look.name}"?`)) onDeleteLook(look.id);
                    }}
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

export default function Page() {
  const store = useWardrobeStore();
  const [view, setView] = useState<"matcher" | "trips">("matcher");
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [categoryTab, setCategoryTab] = useState<Category | "All">("All");

  if (!store.hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-neutral-400">
        Loading…
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
            onEditLook={(lookId) => {
              store.loadLookOntoCanvas(lookId);
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
      {showSave && <SaveLookModal trips={store.trips} onClose={() => setShowSave(false)} onSave={store.saveLook} />}
    </div>
  );
}
