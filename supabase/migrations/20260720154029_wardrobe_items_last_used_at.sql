-- Tracks when each wardrobe item was last added to the Mix & Match canvas,
-- so the sidebar can list items most-recently-used first.

alter table public.wardrobe_items
  add column if not exists last_used_at timestamptz not null default now();

create index if not exists wardrobe_items_last_used_at_idx
  on public.wardrobe_items (last_used_at desc);
