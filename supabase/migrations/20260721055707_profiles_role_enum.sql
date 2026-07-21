-- Convert profiles.role from text+check into a proper enum, adding ADMIN
-- and USER_NEW. New profiles now default to USER_NEW (unapproved) instead
-- of USER_PLAN_LITE, until a plan role is granted manually.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('USER_PLAN_LITE', 'USER_PLAN_PRO', 'ADMIN', 'USER_NEW');
  end if;
end
$$;

alter table public.profiles drop constraint if exists profiles_role_check;

-- The old default can't auto-cast to the new enum type in the same
-- statement as the type change, so drop it, change the type, then set the
-- new default as separate steps.
alter table public.profiles alter column role drop default;

alter table public.profiles
  alter column role type public.user_role using role::public.user_role;

alter table public.profiles
  alter column role set default 'USER_NEW'::public.user_role;
