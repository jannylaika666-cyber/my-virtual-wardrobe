-- Adds a per-user plan role, checked by proxy.ts to gate access to /app.
-- Valid roles: USER_PLAN_LITE, USER_PLAN_PRO. Any other value (or a missing
-- profile row) is treated as access-denied.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'USER_PLAN_LITE' check (role in ('USER_PLAN_LITE', 'USER_PLAN_PRO')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

-- Auto-provision a profile (defaulting to USER_PLAN_LITE) whenever a new
-- auth user is created, so newly registered accounts aren't locked out.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any accounts that already existed before this
-- migration, so they default to USER_PLAN_LITE instead of being denied.
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;
