import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getClaimsMock = vi.fn();
const getUserMock = vi.fn();
const signOutMock = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  isAuthRetryableFetchError: (e: unknown) => (e as { name?: string } | null)?.name === "AuthRetryableFetchError",
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getClaims: getClaimsMock, getUser: getUserMock, signOut: signOutMock },
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
});

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
    getUserMock.mockResolvedValue({
      data: { user: null },
      error: { code: "session_not_found", message: "Session from session_id claim in JWT does not exist" },
    });
  });

  it.each(["/login", "/signup"])("shows %s instead of bouncing to /, and clears the dead session", async (path) => {
    const res = await proxy(req(path));
    expect(locationOf(res)).toBeNull();
    expect(signOutMock).toHaveBeenCalledWith({ scope: "local" });
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
      error: { name: "AuthRetryableFetchError", status: 503, message: "Service Unavailable" },
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
