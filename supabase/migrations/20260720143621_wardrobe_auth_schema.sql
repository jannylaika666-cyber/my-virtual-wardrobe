-- Virtual Wardrobe — Supabase schema (v2: real per-user auth)
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- This version replaces the earlier single-shared-password design with real
-- Supabase Auth (email/password). Every row is now scoped to the signed-in
-- user via `user_id`, and Row Level Security restricts each user to their
-- own data — a real security boundary, not just a UI gate.
--
-- If you're upgrading from the v1 schema (anon-key, no user_id), drop the
-- old policies and tables first, or run this against a fresh project.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.wardrobe_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  category text not null check (
    category in ('Top', 'Bottom', 'Accessory', 'Footwear', 'Outer', 'Swimwear', 'Activewear')
  ),
  image_url text not null,
  image_path text not null, -- storage object path ("<user_id>/<file>.png"), needed to delete the file later
  created_at timestamptz not null default now()
);

create table if not exists public.looks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  canvas_items jsonb not null default '[]'::jsonb, -- placed items: [{id,itemId,x,y,width,height,zIndex}]
  trip_id uuid references public.trips (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists trips_user_id_idx on public.trips (user_id);
create index if not exists wardrobe_items_user_id_idx on public.wardrobe_items (user_id);
create index if not exists looks_user_id_idx on public.looks (user_id);
create index if not exists looks_trip_id_idx on public.looks (trip_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — scoped to the signed-in user (auth.uid())
-- ---------------------------------------------------------------------------

alter table public.trips enable row level security;
alter table public.wardrobe_items enable row level security;
alter table public.looks enable row level security;

drop policy if exists "Allow anon full access to trips" on public.trips;
drop policy if exists "Users manage their own trips" on public.trips;
create policy "Users manage their own trips"
  on public.trips for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Allow anon full access to wardrobe_items" on public.wardrobe_items;
drop policy if exists "Users manage their own wardrobe items" on public.wardrobe_items;
create policy "Users manage their own wardrobe items"
  on public.wardrobe_items for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Allow anon full access to looks" on public.looks;
drop policy if exists "Users manage their own looks" on public.looks;
create policy "Users manage their own looks"
  on public.looks for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime
-- Adding these tables to the supabase_realtime publication is what makes
-- changes on one device show up instantly on another. RLS still applies to
-- realtime — a user only receives change events for their own rows.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.trips;
alter publication supabase_realtime add table public.wardrobe_items;
alter publication supabase_realtime add table public.looks;

-- ---------------------------------------------------------------------------
-- Storage bucket for clothing photos
--
-- Images are uploaded to "<user_id>/<file>.png". The bucket stays public for
-- read (so <img> tags can use the URL directly with no signed-URL dance),
-- but insert/delete are restricted to the authenticated user whose uid
-- matches the first path segment — the standard Supabase pattern for
-- per-user-scoped storage.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('wardrobe-images', 'wardrobe-images', true)
on conflict (id) do nothing;

drop policy if exists "Public read access to wardrobe images" on storage.objects;
create policy "Public read access to wardrobe images"
  on storage.objects for select
  to public
  using (bucket_id = 'wardrobe-images');

drop policy if exists "Anon can upload wardrobe images" on storage.objects;
drop policy if exists "Users can upload their own wardrobe images" on storage.objects;
create policy "Users can upload their own wardrobe images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'wardrobe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Anon can delete wardrobe images" on storage.objects;
drop policy if exists "Users can delete their own wardrobe images" on storage.objects;
create policy "Users can delete their own wardrobe images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'wardrobe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
