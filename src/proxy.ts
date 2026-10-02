import { createServerClient } from "@supabase/ssr";
import { isAuthApiError, type AuthError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { EXPIRED_SESSION_COOKIE, sessionCookieMatcher } from "@/lib/supabase/sessionCookie";

// Coarse "is there a session at all" gate, run on every request. This
// deliberately does NOT import anything from src/lib/{cluster,ingest,
// triage,writeCard}.ts — they load the embedding model, which has no place
// in code that runs before every single request.
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

// True only when Auth explicitly answered that the token's user or session is
// no good. A 429, a 4xx with no JSON body from something in front of Auth, a
// 5xx or a network failure says nothing about the session, so none of them
// count. session_not_found is not here either: auth-js turns it into
// AuthSessionMissingError and drops that session inside getUser itself.
function tokenRejected(error: AuthError | null): boolean {
  return isAuthApiError(error) && [401, 403, 404].includes(error.status);
}

function clearSessionCookies(request: NextRequest, response: NextResponse) {
  const isSessionCookie = sessionCookieMatcher();
  for (const { name } of request.cookies.getAll()) {
    if (isSessionCookie(name)) response.cookies.set(name, "", EXPIRED_SESSION_COOKIE);
  }
}

// The one signed-in visit /login keeps. /auth/confirm sends a recovery link
// here, unspent, when RECOVERY_MARKER_SECRET is missing; bouncing a signed-in
// visitor to / would lose the message. Exactly one error value, as the page
// renders nothing for a repeated one.
function showsResetUnavailable(url: NextRequest["nextUrl"]): boolean {
  const errors = url.searchParams.getAll("error");
  return url.pathname === "/login" && errors.length === 1 && errors[0] === "reset_unavailable";
}

// auth-js sets no timeout of its own, so a hanging Auth would hang /login.
const AUTH_PAGE_DEADLINE_MS = 5000;

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // Armed only for the /login and /signup check below. A token refresh cut off
  // mid-flight can leave the browser holding a refresh token Auth has already
  // replaced, so no refresh of a live session may run under it.
  let authDeadline: AbortSignal | undefined;
  const authFetch: typeof fetch = (input, init) =>
    fetch(
      input,
      authDeadline
        ? { ...init, signal: init?.signal ? AbortSignal.any([init.signal, authDeadline]) : authDeadline }
        : init
    );

  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      global: { fetch: authFetch },
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
    //
    // The token is read before the deadline is armed, because reading the
    // session may refresh it. Nothing after that reloads the session: getUser
    // given a token sends only GET /user, so no refresh runs under the deadline.
    const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
    if (accessToken) {
      // One deadline covers every Auth call from here on. A call it cuts off
      // fails as a network error, so it counts as "Auth didn't answer".
      authDeadline = AbortSignal.timeout(AUTH_PAGE_DEADLINE_MS);
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser(accessToken);
      if (user) {
        if (showsResetUnavailable(request.nextUrl)) return supabaseResponse;
        const url = request.nextUrl.clone();
        url.pathname = "/";
        return NextResponse.redirect(url);
      }
      // Either way /login renders, which is what ends the loop. The cookies are
      // cleared only when Auth actually answered that the session is gone;
      // clearing on any other error would sign out a live user whenever Auth is
      // rate-limiting or down.
      if (tokenRejected(error)) {
        // Not auth.signOut(): it reloads the session first, which can start a
        // refresh whose retry loop outlasts the deadline. This is the same
        // POST /logout signOut sends, for the token Auth just rejected.
        await supabase.auth.admin.signOut(accessToken, "local");
        clearSessionCookies(request, supabaseResponse);
      }
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
