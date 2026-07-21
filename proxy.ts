import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

const AUTH_PATHS = ["/auth/signin", "/auth/register"];
// Anything under /app is the authenticated part of the product.
const PROTECTED_PREFIX = "/app";
// Only these roles (set on public.profiles.role) may use /app.
// USER_NEW (the default for freshly created accounts) is deliberately
// excluded — new signups stay locked out until manually upgraded.
const ALLOWED_ROLES = ["USER_PLAN_LITE", "USER_PLAN_PRO", "ADMIN"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase isn't configured yet, don't lock the app behind a screen
  // that can never succeed — send people to sign-in with a clear signal.
  if (!supabaseUrl || !supabaseAnonKey) {
    if (pathname.startsWith(PROTECTED_PREFIX)) {
      const url = new URL("/auth/signin", request.url);
      url.searchParams.set("misconfigured", "1");
      return NextResponse.redirect(url);
    }
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getUser() (not getSession()) revalidates the token against Supabase Auth
  // rather than just trusting the local cookie — the right check to make
  // in Proxy.
  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch (err) {
    console.error("Supabase auth check failed in proxy:", err);
  }

  const isProtected = pathname.startsWith(PROTECTED_PREFIX);
  const isAuthPage = AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (isProtected && !user) {
    const url = new URL("/auth/signin", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Plan-gate: /app requires a profiles.role of USER_PLAN_LITE or
  // USER_PLAN_PRO. Fail closed — if the role can't be loaded, deny access
  // rather than letting an unverified user through.
  if (isProtected && user) {
    let role: string | null = null;
    try {
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      role = profile?.role ?? null;
    } catch (err) {
      console.error("Failed to load user role in proxy:", err);
    }

    if (!role || !ALLOWED_ROLES.includes(role)) {
      return new NextResponse("403 Access Denied", { status: 403 });
    }
  }

  if (isAuthPage && user) {
    return NextResponse.redirect(new URL("/app/wardrobe", request.url));
  }

  return response;
}

export const config = {
  // Run on everything except Next's own static/image assets and the auth
  // callback route (which needs to run unauthenticated to exchange a code).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|auth/callback).*)"],
};
