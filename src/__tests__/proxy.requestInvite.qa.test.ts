import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// /request-invite is reachable without an account (the page and its server
// action, which posts to the same path); /admin/requests is not.

const getClaimsMock = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getClaims: getClaimsMock,
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      getUser: vi.fn(),
      signOut: vi.fn(),
      admin: { signOut: vi.fn() },
    },
  })),
}));

const { proxy } = await import("@/proxy");

const ORIGIN = "https://news.h72labs.com";
const req = (path: string, init?: RequestInit) => new NextRequest(new Request(`${ORIGIN}${path}`, init));
const location = (res: Response) => {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
};

beforeEach(() => {
  getClaimsMock.mockReset().mockResolvedValue({ data: null });
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
});
afterEach(() => vi.unstubAllEnvs());

describe("proxy and invite requests", () => {
  it("lets a signed-out visitor reach /request-invite", async () => {
    expect(location(await proxy(req("/request-invite")))).toBeNull();
  });

  it("lets the form's server action post to /request-invite while signed out", async () => {
    const res = await proxy(req("/request-invite", { method: "POST", headers: { "Next-Action": "abc" }, body: "x" }));
    expect(location(res)).toBeNull();
  });

  it("keeps the query string public too", async () => {
    expect(location(await proxy(req("/request-invite?utm=x")))).toBeNull();
  });

  it.each(["/request-invite/x", "/request-invites", "/admin/requests", "/admin"])(
    "sends a signed-out visitor at %s to /login",
    async (path) => {
      expect(location(await proxy(req(path)))).toBe("/login");
    }
  );

  it("does not bounce a signed-in reader away from /request-invite", async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "u" } } });
    expect(location(await proxy(req("/request-invite")))).toBeNull();
  });
});
