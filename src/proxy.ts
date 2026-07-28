import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Coarse "is there a session at all" gate, run on every request. This
// deliberately does NOT import anything from src/lib/{cluster,ingest,
// triage,writeCard}.ts — those need Node APIs (@xenova/transformers) and
// middleware runs on the Edge runtime.
const PUBLIC_PATHS = ["/login", "/signup", "/auth/callback"];

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getClaims() verifies the JWT locally (fast, no network round-trip) —
  // right-sized for a check that runs on every single request. The one
  // place that's actually authorization-critical (POST /api/digest, which
  // gates real user data and real Claude spend) independently re-checks
  // with getUser() (network-verified) instead of trusting this.
  const { data } = await supabase.auth.getClaims();
  const isAuthed = !!data?.claims;
  // Exact match, not startsWith — a prefix check would also match a future
  // route like "/login-foo" as "public" by accident.
  const isPublicPath = PUBLIC_PATHS.includes(request.nextUrl.pathname);
  // API routes authenticate themselves and return a proper status code
  // (e.g. POST /api/digest's own getUser() check) rather than a page
  // redirect — a 307 to /login doesn't degrade cleanly for a fetch() call
  // (the browser follows it, preserving the POST method/body, and lands
  // on a page route that isn't built to receive one).
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/");

  if (!isAuthed && !isPublicPath && !isApiRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (isAuthed && (request.nextUrl.pathname === "/login" || request.nextUrl.pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Skip static assets and image optimization requests — no session
    // check needed there, and it'd add latency to every asset fetch.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
