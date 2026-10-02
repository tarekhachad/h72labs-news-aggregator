import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, AuthUnknownError } from "@supabase/supabase-js";

const getClaimsMock = vi.fn();
const getUserMock = vi.fn();
const signOutMock = vi.fn();
const adminSignOutMock = vi.fn();
const getSessionMock = vi.fn(async () => ({ data: { session: { access_token: "token-1" } }, error: null }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getClaims: getClaimsMock,
      getSession: getSessionMock,
      getUser: getUserMock,
      signOut: signOutMock,
      admin: { signOut: adminSignOutMock },
    },
  })),
}));

const { proxy } = await import("@/proxy");

const ORIGIN = "https://news.h72labs.com";

function req(path: string): NextRequest {
  return new NextRequest(new Request(`${ORIGIN}${path}`));
}

beforeEach(() => {
  getClaimsMock.mockReset();
  getClaimsMock.mockResolvedValue({ data: null });
  getUserMock.mockReset();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  signOutMock.mockReset();
  signOutMock.mockResolvedValue({ error: null });
  adminSignOutMock.mockReset();
  adminSignOutMock.mockResolvedValue({ data: null, error: null });
  // The project ref in SESSION below comes from this URL's first label.
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// The session cookie a real browser would send, and its expiry on the response.
const SESSION = "sb-127-auth-token";
function reqWithSession(path: string): NextRequest {
  return new NextRequest(new Request(`${ORIGIN}${path}`, { headers: { cookie: `${SESSION}=base64-x; ${SESSION}.1=y; theme=dark` } }));
}
const expired = (res: Response) =>
  res.headers.getSetCookie().filter((l) => /max-age=0/i.test(l)).map((l) => l.slice(0, l.indexOf("=")));

function locationOf(response: Response): string | null {
  const loc = response.headers.get("location");
  if (!loc) return null;
  return new URL(loc).pathname;
}

describe("proxy — unauthenticated", () => {
  it("redirects a protected page to /login", async () => {
    const res = await proxy(req("/"));
    expect(locationOf(res)).toBe("/login");
  });

  it.each(["/login", "/signup", "/signup/check-email", "/forgot-password", "/auth/callback", "/auth/confirm"])(
    "lets an unauthenticated visitor reach public path %s",
    async (path) => {
      const res = await proxy(req(path));
      expect(locationOf(res)).toBeNull();
    }
  );

  it("does NOT treat /reset-password as public — it requires the recovery session middleware can't see here", async () => {
    const res = await proxy(req("/reset-password"));
    expect(locationOf(res)).toBe("/login");
  });

  it.each(["/login-foo", "/loginx", "/signup-extra", "/auth/confirm-extra"])(
    "does not let a path that merely starts with a public prefix (%s) slip through unauthenticated",
    async (path) => {
      const res = await proxy(req(path));
      expect(locationOf(res)).toBe("/login");
    }
  );

  it("does not redirect an /api/* route — it authenticates itself", async () => {
    const res = await proxy(req("/api/digest"));
    expect(locationOf(res)).toBeNull();
  });
});

describe("proxy — authenticated", () => {
  beforeEach(() => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
  });

  it("lets an authenticated visitor reach a protected page", async () => {
    const res = await proxy(req("/"));
    expect(locationOf(res)).toBeNull();
  });

  it("checks the session's own token with Auth, so getUser cannot refresh it", async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    await proxy(req("/login"));
    expect(getUserMock).toHaveBeenCalledWith("token-1");
  });

  it("bounces an authenticated visitor away from /login", async () => {
    const res = await proxy(req("/login"));
    expect(locationOf(res)).toBe("/");
  });

  it("bounces an authenticated visitor away from /signup", async () => {
    const res = await proxy(req("/signup"));
    expect(locationOf(res)).toBe("/");
  });

  it("does not bounce an authenticated visitor away from /signup/check-email", async () => {
    // Only the exact "/signup" path is redirected away when authed, not
    // every path that starts with it.
    const res = await proxy(req("/signup/check-email"));
    expect(locationOf(res)).toBeNull();
  });
});

// A browser whose session was revoked (a password reset elsewhere signed it
// out) still holds an access token with a valid signature for up to an hour.
// The pages ask Auth and send it to /login; bouncing it back to / on the token
// alone is the redirect loop this guards against.
describe("proxy — token still valid, session revoked", () => {
  beforeEach(() => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    // auth-js turns a session_not_found answer into AuthSessionMissingError.
    getUserMock.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
  });

  // auth-js drops a session_not_found session inside getUser, so the proxy
  // has nothing left to revoke or clear.
  it.each(["/login", "/signup"])("shows %s instead of bouncing to /, and revokes nothing more", async (path) => {
    const res = await proxy(req(path));
    expect(locationOf(res)).toBeNull();
    expect(adminSignOutMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("keeps the query on /login so its message still shows", async () => {
    const res = await proxy(req("/login?error=link_expired"));
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy — Auth is asked only on /login and /signup", () => {
  it.each(["/", "/profile", "/saved", "/history", "/reset-password", "/api/digest"])(
    "does not call getUser for %s",
    async (path) => {
      getClaimsMock.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
      await proxy(req(path));
      expect(getUserMock).not.toHaveBeenCalled();
    }
  );

  it("does not call getUser on /login for a visitor with no token at all", async () => {
    await proxy(req("/login"));
    expect(getUserMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("does not sign out a live session on /login", async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    await proxy(req("/login"));
    expect(signOutMock).not.toHaveBeenCalled();
  });
});

// A network failure or a 5xx from Auth says nothing about whether the session
// is alive, so the proxy must not clear a live user's cookies on one.
describe("proxy — Auth unreachable on /login", () => {
  beforeEach(() => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    getUserMock.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError("Service Unavailable", 503),
    });
  });

  it("renders /login without bouncing, so there is still no loop", async () => {
    const res = await proxy(req("/login"));
    expect(locationOf(res)).toBeNull();
  });

  it("keeps the session's cookies", async () => {
    await proxy(req("/login"));
    expect(signOutMock).not.toHaveBeenCalled();
  });
});

// Only an explicit "this session or user is gone" from Auth clears the cookies.
describe("proxy — which Auth errors clear the session on /login", () => {
  beforeEach(() => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
  });

  it.each([
    ["401", new AuthApiError("invalid JWT", 401, "bad_jwt")],
    ["403 user_not_found", new AuthApiError("User from sub claim in JWT does not exist", 403, "user_not_found")],
    ["404", new AuthApiError("not found", 404, undefined)],
  ])("revokes the rejected token and expires every session cookie on %s", async (_label, error) => {
    getUserMock.mockResolvedValue({ data: { user: null }, error });
    const res = await proxy(reqWithSession("/login"));
    expect(locationOf(res)).toBeNull();
    expect(adminSignOutMock).toHaveBeenCalledWith("token-1", "local");
    expect(signOutMock).not.toHaveBeenCalled();
    expect(expired(res).sort()).toEqual([SESSION, `${SESSION}.1`]);
  });

  it("still expires the cookies when revoking fails", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new AuthApiError("gone", 403, "user_not_found") });
    adminSignOutMock.mockResolvedValue({ data: null, error: new AuthRetryableFetchError("fetch failed", 0) });
    const res = await proxy(reqWithSession("/login"));
    expect(expired(res).sort()).toEqual([SESSION, `${SESSION}.1`]);
  });

  it("leaves a missing session to auth-js, which already dropped it", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    const res = await proxy(reqWithSession("/login"));
    expect(adminSignOutMock).not.toHaveBeenCalled();
    expect(expired(res)).toEqual([]);
  });

  it.each([
    ["429", new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit")],
    ["400", new AuthApiError("bad request", 400, "validation_failed")],
    ["a 4xx with no JSON body", new AuthUnknownError("Unexpected token <", new SyntaxError("Unexpected token <"))],
    ["a 503", new AuthRetryableFetchError("Service Unavailable", 503)],
    ["a network failure", new AuthRetryableFetchError("fetch failed", 0)],
  ])("keeps the session on %s and still renders /login", async (_label, error) => {
    getUserMock.mockResolvedValue({ data: { user: null }, error });
    const res = await proxy(reqWithSession("/login"));
    expect(locationOf(res)).toBeNull();
    expect(adminSignOutMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(expired(res)).toEqual([]);
  });
});
