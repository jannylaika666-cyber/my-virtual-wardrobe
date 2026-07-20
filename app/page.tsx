import { redirect } from "next/navigation";

// The wardrobe app itself now lives at /app/wardrobe (see app/app/wardrobe/page.tsx).
// proxy.ts protects everything under /app, so unauthenticated visitors land
// here, get redirected to /app/wardrobe, and proxy bounces them again to
// /auth/signin.
export default function RootPage() {
  redirect("/app/wardrobe");
}
