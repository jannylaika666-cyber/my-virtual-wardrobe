# My Virtual Wardrobe

A personal wardrobe app: catalog your clothes, mix and match outfits on a
drag-and-drop canvas, and archive favorite looks into trips. Built with
Next.js (App Router) and Supabase (Auth, Postgres, Storage, Realtime).

## Features

- **Wardrobe** — add clothing photos (file picker, drag-and-drop, or paste
  from clipboard), organize by category, rename or delete items
- **Mix & Match canvas** — drag items onto a canvas, select an item to reveal
  4-corner resize handles, save the arrangement as a "look"
- **Trips** — archive looks into named trips; reopening a look for editing
  loads it back onto the canvas
- **Auth** — Supabase email/password sign-in, gated by a per-user plan role
- **Realtime sync** — edits on one device appear on another automatically
- **PWA** — installable ("Add to Home Screen") with a web manifest and icons

## URL paths

| Path                          | Description                                       | Auth required |
| ------------------------------ | -------------------------------------------------- | -------------- |
| `/`                             | Redirects to `/app/wardrobe`                        | —              |
| `/auth/signin`                  | Sign in                                             | No             |
| `/auth/register`                | Create an account                                   | No             |
| `/auth/callback`                | Supabase email confirmation / magic-link callback   | No             |
| `/app/wardrobe`                 | Wardrobe sidebar + Mix & Match canvas                | Yes            |
| `/app/wardrobe?editLook=<id>`   | Loads a saved look onto the canvas for editing       | Yes            |
| `/app/trip`                     | List of trips                                       | Yes            |
| `/app/trip/[tripId]`            | Looks archived under one trip                       | Yes            |

Routes under `/app` require a signed-in user whose `profiles.role` is
`USER_PLAN_LITE`, `USER_PLAN_PRO`, or `ADMIN` (enforced in `proxy.ts`);
anything else — including the `USER_NEW` default given to new signups —
gets a plain 403 response.

## Getting started

1. Add a `.env.local` with your Supabase project's URL and anon/publishable key:

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-or-publishable-key>
   ```

2. Apply the database migrations in `supabase/migrations/` — either paste
   each file into the Supabase SQL Editor in order, or run
   `supabase db push --linked` if you have the CLI installed and linked to
   your project.

3. Install dependencies and start the dev server:

   ```bash
   npm install
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Tech stack

- **Next.js 16** (App Router). Note: this version renamed `middleware.ts` to
  `proxy.ts` — see `proxy.ts` for route protection.
- **Supabase** — Auth, Postgres with Row Level Security, Storage, Realtime
- **Tailwind CSS 4**
- **TypeScript**

## Project structure

- `app/` — routes (see [URL paths](#url-paths) above)
- `lib/wardrobe.tsx` — shared data layer (Supabase-backed store, provided via
  React Context from `app/app/layout.tsx` so it survives navigation between
  `/app/wardrobe` and `/app/trip`) plus the Trips list/detail view components
- `lib/supabase/` — browser and server Supabase client helpers
- `proxy.ts` — signed-in check + plan-role gating for everything under `/app`
- `supabase/migrations/` — SQL migrations: core tables, RLS policies, storage
  bucket policies, and the `profiles.role` access gate
