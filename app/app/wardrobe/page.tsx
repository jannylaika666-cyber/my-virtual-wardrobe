"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  CATEGORIES,
  clamp,
  downscaleImage,
  useWardrobeStoreContext,
  type Category,
  type CanvasItem,
  type Trip,
  type WardrobeItem,
} from "@/lib/wardrobe";

/* -------------------------------------------------------------------------
 * Virtual Wardrobe — /app/wardrobe (the Mix & Match canvas + sidebar)
 *
 * Shared data (items/looks/trips, Supabase client, realtime subscription)
 * lives in lib/wardrobe.tsx and is provided by app/app/layout.tsx, so it
 * survives navigating to /app/trip and back — including any in-progress
 * canvas arrangement.
 * ---------------------------------------------------------------------- */

const SIDEBAR_PAGE_SIZE = 50;

/* --------------------------- Canvas item (drag/resize) -------------------- */

const RESIZE_CORNERS = ["nw", "ne", "sw", "se"] as const;
type ResizeCorner = (typeof RESIZE_CORNERS)[number];

const RESIZE_CORNER_STYLE: Record<ResizeCorner, string> = {
  nw: "-top-1.5 -left-1.5 cursor-nwse-resize",
  ne: "-top-1.5 -right-1.5 cursor-nesw-resize",
  sw: "-bottom-1.5 -left-1.5 cursor-nesw-resize",
  se: "-bottom-1.5 -right-1.5 cursor-nwse-resize",
};

function CanvasItemView({
  ci,
  item,
  selected,
  onSelect,
  onUpdate,
  onBringToFront,
  onRemove,
}: {
  ci: CanvasItem;
  item: WardrobeItem;
  selected: boolean;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<CanvasItem>) => void;
  onBringToFront: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  function handleDragPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(ci.id);
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

  // Resizing keeps the aspect ratio and anchors the opposite corner in
  // place — dragging the nw handle grows the box up-left while the se
  // corner stays put, and so on.
  function handleResizePointerDown(e: React.PointerEvent<HTMLDivElement>, corner: ResizeCorner) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(ci.id);
    onBringToFront(ci.id);
    const startX = e.clientX;
    const startW = ci.width;
    const startH = ci.height;
    const startCX = ci.x;
    const startCY = ci.y;
    const aspect = startW / startH;
    const growsLeft = corner === "nw" || corner === "sw";
    const growsUp = corner === "nw" || corner === "ne";

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const newWidth = clamp(startW + (growsLeft ? -dx : dx), 60, 500);
      const newHeight = newWidth / aspect;
      const deltaW = newWidth - startW;
      const deltaH = newHeight - startH;
      const newX = growsLeft ? startCX - deltaW : startCX;
      const newY = growsUp ? startCY - deltaH : startCY;

      onUpdate(ci.id, {
        width: newWidth,
        height: newHeight,
        x: clamp(newX, 0, CANVAS_WIDTH - newWidth),
        y: clamp(newY, 0, CANVAS_HEIGHT - newHeight),
      });
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
      className={`absolute left-0 top-0 group cursor-grab active:cursor-grabbing ${
        selected ? "ring-2 ring-neutral-900" : ""
      }`}
      style={{
        transform: `translate3d(${ci.x}px, ${ci.y}px, 0)`,
        width: ci.width,
        height: ci.height,
        zIndex: ci.zIndex,
        touchAction: "none",
        willChange: "transform",
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
        className="absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center bg-white border border-neutral-200 rounded-full text-neutral-400 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:text-red-500 shadow-sm transition duration-150 text-xs leading-none"
        title="Remove from canvas"
      >
        ×
      </button>
      {selected &&
        RESIZE_CORNERS.map((corner) => (
          <div
            key={corner}
            onPointerDown={(e) => handleResizePointerDown(e, corner)}
            className={`absolute w-3.5 h-3.5 bg-white border-2 border-neutral-900 rounded-full ${RESIZE_CORNER_STYLE[corner]}`}
          />
        ))}
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
  onOpenSidebar,
  draggingItemId,
}: {
  items: WardrobeItem[];
  canvasItems: CanvasItem[];
  addToCanvas: (itemId: string) => void;
  updateCanvasItem: (id: string, patch: Partial<CanvasItem>) => void;
  bringToFront: (id: string) => void;
  removeFromCanvas: (id: string) => void;
  clearCanvas: () => void;
  onRequestSave: () => void;
  onOpenSidebar: () => void;
  draggingItemId: string | null;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [previewPos, setPreviewPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const draggingItem = draggingItemId ? itemMap.get(draggingItemId) ?? null : null;

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(true);
    const rect = e.currentTarget.getBoundingClientRect();
    setPreviewPos({
      x: clamp(e.clientX - rect.left, 0, CANVAS_WIDTH),
      y: clamp(e.clientY - rect.top, 0, CANVAS_HEIGHT),
    });
  }

  function handleDragLeave() {
    setIsDragOver(false);
    setPreviewPos(null);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    setPreviewPos(null);
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
            onClick={onOpenSidebar}
            className="lg:hidden flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 px-3 py-1.5 rounded-full border border-neutral-200 transition duration-150"
          >
            Wardrobe
          </button>
          <button
            onClick={() => {
              clearCanvas();
              setSelectedId(null);
            }}
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

      <div className="flex-1 overflow-auto p-6">
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setSelectedId(null);
          }}
          className={`relative bg-white rounded-2xl border transition duration-200 mx-auto ${
            isDragOver ? "border-neutral-900 border-2" : "border-neutral-200 border-dashed"
          }`}
          style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
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
                selected={ci.id === selectedId}
                onSelect={setSelectedId}
                onUpdate={updateCanvasItem}
                onBringToFront={bringToFront}
                onRemove={removeFromCanvas}
              />
            );
          })}
          {isDragOver && draggingItem && previewPos && (
            <img
              src={draggingItem.imageUrl}
              alt=""
              className="absolute object-contain pointer-events-none select-none opacity-40"
              style={{
                left: previewPos.x - 100,
                top: previewPos.y - 100,
                width: 200,
                height: 200,
                zIndex: 9999,
              }}
            />
          )}
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
  renameItem,
  onOpenUpload,
  activeTab,
  setActiveTab,
  onItemDragStart,
  onItemDragEnd,
  open,
  onClose,
}: {
  items: WardrobeItem[];
  addToCanvas: (itemId: string) => void;
  removeItem: (item: WardrobeItem) => void;
  renameItem: (id: string, name: string) => Promise<unknown>;
  onOpenUpload: (file?: File) => void;
  activeTab: Category | "All";
  setActiveTab: (c: Category | "All") => void;
  onItemDragStart: (itemId: string) => void;
  onItemDragEnd: () => void;
  open: boolean;
  onClose: () => void;
}) {
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);

  function handleFileDragOver(e: React.DragEvent<HTMLElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setIsFileDragOver(true);
  }

  function handleFileDragLeave(e: React.DragEvent<HTMLElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsFileDragOver(false);
  }

  function handleFileDrop(e: React.DragEvent<HTMLElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setIsFileDragOver(false);
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (file) onOpenUpload(file);
  }

  const [visibleCount, setVisibleCount] = useState(SIDEBAR_PAGE_SIZE);
  const [prevTab, setPrevTab] = useState(activeTab);

  // Reset pagination whenever the tab changes (adjusting state during
  // render, per https://react.dev/learn/you-might-not-need-an-effect).
  if (activeTab !== prevTab) {
    setPrevTab(activeTab);
    setVisibleCount(SIDEBAR_PAGE_SIZE);
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const item of items) c[item.category] = (c[item.category] ?? 0) + 1;
    return c;
  }, [items]);

  const filtered = useMemo(() => {
    const scoped = activeTab === "All" ? items : items.filter((i) => i.category === activeTab);
    return [...scoped].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }, [items, activeTab]);

  const visibleItems = filtered.slice(0, visibleCount);

  function handleGridScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      setVisibleCount((c) => Math.min(c + SIDEBAR_PAGE_SIZE, filtered.length));
    }
  }

  const tabs: (Category | "All")[] = ["All", ...CATEGORIES];

  async function handleRemove(item: WardrobeItem) {
    if (!confirm("Are you sure you want to delete this item? It will be permanently removed.")) return;
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

  function startRename(item: WardrobeItem) {
    setEditingId(item.id);
    setEditingName(item.name);
  }

  async function commitRename(item: WardrobeItem) {
    const trimmed = editingName.trim();
    setEditingId(null);
    if (!trimmed || trimmed === item.name) return;
    setRenamingId(item.id);
    try {
      await renameItem(item.id, trimmed);
    } catch (err) {
      console.error(err);
      alert("Couldn't rename this item. Check your connection and try again.");
    } finally {
      setRenamingId(null);
    }
  }

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
        />
      )}
      <aside
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
        className={`fixed inset-y-0 right-0 z-40 w-full max-w-[min(300px,80vw)] transform transition-transform duration-300 ease-in-out shadow-xl ${
          open ? "translate-x-0" : "translate-x-full"
        } lg:static lg:z-auto lg:shadow-none lg:translate-x-0 lg:w-[380px] lg:max-w-none lg:shrink-0 border-l border-neutral-100 flex flex-col h-full bg-white`}
      >
        {isFileDragOver && (
          <div className="absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-neutral-900 bg-white/90 pointer-events-none">
            <span className="text-sm text-neutral-500">Drop photo to add item</span>
          </div>
        )}
        <div className="p-5 border-b border-neutral-100 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-neutral-900">Wardrobe</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onOpenUpload()}
                className="flex items-center gap-1 text-xs bg-neutral-900 text-white rounded-full pl-2 pr-3 py-1.5 hover:bg-neutral-800 transition duration-150"
              >
                <span className="text-sm leading-none">+</span> Add item
              </button>
              <button
                onClick={onClose}
                className="lg:hidden w-7 h-7 flex items-center justify-center rounded-full text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 transition duration-150"
              >
                ×
              </button>
            </div>
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

      <div className="flex-1 overflow-y-auto p-5" onScroll={handleGridScroll}>
        {filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-sm text-neutral-400 px-6">
            {items.length === 0
              ? "Your wardrobe is empty. Add your first item to get started."
              : "Nothing in this category yet."}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {visibleItems.map((item) => (
              <div
                key={item.id}
                draggable={editingId !== item.id}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", item.id);
                  e.dataTransfer.effectAllowed = "copy";
                  onItemDragStart(item.id);
                }}
                onDragEnd={onItemDragEnd}
                onClick={() => {
                  if (editingId !== item.id) addToCanvas(item.id);
                }}
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
                    startRename(item);
                  }}
                  disabled={renamingId === item.id}
                  className="absolute top-1.5 right-7 w-5 h-5 flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 bg-white/90 rounded-full text-neutral-400 hover:text-neutral-900 disabled:opacity-50 transition duration-150 text-xs leading-none"
                  title="Rename"
                >
                  ✎
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(item);
                  }}
                  disabled={removingId === item.id}
                  className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 bg-white/90 rounded-full text-neutral-400 hover:text-red-500 disabled:opacity-50 transition duration-150 text-xs leading-none"
                  title="Delete"
                >
                  ×
                </button>
                {editingId === item.id ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                    onBlur={() => commitRename(item)}
                    className="absolute bottom-1.5 left-1.5 right-1.5 text-[10px] text-neutral-900 bg-white border border-neutral-300 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-neutral-900"
                  />
                ) : (
                  <span className="absolute bottom-1.5 left-1.5 right-1.5 text-[10px] text-neutral-500 truncate bg-white/80 rounded px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition duration-150">
                    {item.name}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
    </>
  );
}

/* -------------------------------- Upload modal ----------------------------- */

function UploadModal({
  onClose,
  onAdd,
  initialFile,
}: {
  onClose: () => void;
  onAdd: (data: { name: string; category: Category; blob: Blob }) => Promise<unknown>;
  initialFile?: File | null;
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

  // A file dropped onto the wardrobe sidebar arrives already selected —
  // skip straight to the review stage instead of showing the file picker.
  useEffect(() => {
    if (initialFile) handleFile(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Let Ctrl/Cmd+V paste a copied image straight into the modal.
  useEffect(() => {
    function handlePaste(e: ClipboardEvent) {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      handleFile(file);
    }
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, []);

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
            <span className="text-xs text-neutral-300">or paste an image with Ctrl/Cmd+V</span>
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

/* ----------------------------------- Page ----------------------------------- */

export default function WardrobePage({
  searchParams,
}: {
  searchParams: Promise<{ editLook?: string }>;
}) {
  const { editLook } = use(searchParams);
  const store = useWardrobeStoreContext();
  const router = useRouter();
  const [showUpload, setShowUpload] = useState(false);
  const [initialUploadFile, setInitialUploadFile] = useState<File | null>(null);
  const [showSave, setShowSave] = useState(false);
  const [categoryTab, setCategoryTab] = useState<Category | "All">("All");
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const loadedEditLookRef = useRef<string | null>(null);

  // Coming from "Edit" on a trip's look (/app/wardrobe?editLook=<id>): load
  // that look onto the canvas once, then strip the query param.
  useEffect(() => {
    if (!editLook || store.loading || loadedEditLookRef.current === editLook) return;
    const look = store.looks.find((l) => l.id === editLook);
    if (!look) return;
    store.loadLookOntoCanvas(look);
    loadedEditLookRef.current = editLook;
    router.replace("/app/wardrobe");
  }, [editLook, store, router]);

  // Warn before closing the tab/browser if there's an in-progress canvas
  // arrangement that hasn't been saved as a look yet. Browsers ignore any
  // custom message text and show their own generic confirmation instead.
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (store.canvasItems.length === 0) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [store.canvasItems.length]);

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
          <p className="text-sm text-neutral-900 mb-1">Couldn&apos;t load your wardrobe</p>
          <p className="text-xs text-neutral-400">{store.error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row h-full">
      <MatchCanvas
        items={store.items}
        canvasItems={store.canvasItems}
        addToCanvas={store.addToCanvas}
        updateCanvasItem={store.updateCanvasItem}
        bringToFront={store.bringToFront}
        removeFromCanvas={store.removeFromCanvas}
        clearCanvas={store.clearCanvas}
        onRequestSave={() => setShowSave(true)}
        onOpenSidebar={() => setSidebarOpen(true)}
        draggingItemId={draggingItemId}
      />
      <WardrobePanel
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        items={store.items}
        addToCanvas={store.addToCanvas}
        removeItem={store.removeItem}
        renameItem={store.renameItem}
        onOpenUpload={(file) => {
          setInitialUploadFile(file ?? null);
          setShowUpload(true);
        }}
        activeTab={categoryTab}
        setActiveTab={setCategoryTab}
        onItemDragStart={setDraggingItemId}
        onItemDragEnd={() => setDraggingItemId(null)}
      />

      {showUpload && (
        <UploadModal
          initialFile={initialUploadFile}
          onClose={() => {
            setShowUpload(false);
            setInitialUploadFile(null);
          }}
          onAdd={store.addItem}
        />
      )}
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
