import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getClaimsMock = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getClaims: getClaimsMock },
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
