import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

// Coarse "is there a session at all" gate, run on every request. This
// deliberately does NOT import anything from src/lib/{cluster,ingest,
// triage,writeCard}.ts — those need Node APIs (@xenova/transformers) and
// middleware runs on the Edge runtime.
// /reset-password is deliberately absent: the recovery link establishes a
// session before landing there, so it is reached as a signed-in page.
const PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/signup/check-email",
  "/forgot-password",
  "/auth/callback",
  "/auth/confirm",
];

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
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
    // getClaims only checks the token's signature, and a token outlives its
    // session by up to an hour, e.g. after a password reset signed this
    // browser out. The pages check with Auth and send that browser here, so
    // bouncing it back on the token alone loops until Chrome gives up. Auth
    // decides, and only on these two pages, so every other request stays local.
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (user) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    // Either way /login renders, which is what ends the loop. The cookies are
    // cleared only when Auth actually answered that the session is gone. A
    // network error or a 5xx says nothing about the session, and clearing on
    // one would sign out every live user who loads a page during an outage.
    if (!isAuthRetryableFetchError(error)) {
      await supabase.auth.signOut({ scope: "local" });
    }
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
