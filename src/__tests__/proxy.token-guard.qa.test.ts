// QA: the order and the guard of the /login check, against a mocked
// client. getSession runs before anything is armed, and getUser only ever gets
// a token; with no token there is no Auth check at all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

const order: string[] = [];
const getClaimsMock = vi.fn();
const getSessionMock = vi.fn();
const getUserMock = vi.fn();
const signOutMock = vi.fn();
const adminSignOutMock = vi.fn();
let fetchOption: typeof fetch | undefined;
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_u: string, _k: string, opts: { global?: { fetch?: typeof fetch } }) => {
    fetchOption = opts.global?.fetch;
    return {
      auth: { getClaims: getClaimsMock, getSession: getSessionMock, getUser: getUserMock, signOut: signOutMock, admin: { signOut: adminSignOutMock } },
    };
  }),
}));

const { proxy } = await import("@/proxy");
const req = (path: string) => new NextRequest(new Request(`https://news.h72labs.com${path}`));
const location = (res: Response) => (res.headers.get("location") ? new URL(res.headers.get("location")!).pathname : null);

// Records whether the proxy's own fetch would attach a signal at the moment
// each auth method is entered.
const realFetch = globalThis.fetch;
let seenSignal: Record<string, boolean>;
async function probe(name: string) {
  order.push(name);
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    captured = init;
    return new Response("{}");
  }) as typeof fetch;
  try {
    await fetchOption!("http://x/probe", {});
  } finally {
    globalThis.fetch = realFetch;
  }
  seenSignal[name] = !!captured?.signal;
}

beforeEach(() => {
  order.length = 0;
  seenSignal = {};
  getClaimsMock.mockReset().mockImplementation(async () => { await probe("getClaims"); return { data: { claims: { sub: "u" } } }; });
  getSessionMock.mockReset().mockImplementation(async () => { await probe("getSession"); return { data: { session: { access_token: "tok" } }, error: null }; });
  getUserMock.mockReset().mockImplementation(async () => { await probe("getUser"); return { data: { user: { id: "u" } }, error: null }; });
  signOutMock.mockReset().mockImplementation(async () => { await probe("signOut"); return { error: null }; });
  adminSignOutMock.mockReset().mockImplementation(async () => { await probe("revoke"); return { data: null, error: null }; });
});

describe("order and arming", () => {
  it.each(["/login", "/signup"])("%s: getClaims and getSession unarmed, then getUser(token) armed", async (path) => {
    const res = await proxy(req(path));
    expect(order).toEqual(["getClaims", "getSession", "getUser"]);
    expect(seenSignal).toEqual({ getClaims: false, getSession: false, getUser: true });
    expect(getUserMock).toHaveBeenCalledWith("tok");
    expect(location(res)).toBe("/");
  });

  it("a rejected token is revoked under the deadline without reloading the session", async () => {
    getUserMock.mockImplementation(async () => {
      await probe("getUser");
      return { data: { user: null }, error: new AuthApiError("gone", 403, "user_not_found") };
    });
    await proxy(req("/login"));
    expect(order).toEqual(["getClaims", "getSession", "getUser", "revoke"]);
    expect(seenSignal.revoke).toBe(true);
    expect(adminSignOutMock).toHaveBeenCalledWith("tok", "local");
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("other pages never call getSession or getUser", async () => {
    await proxy(req("/"));
    await proxy(req("/profile"));
    expect(order).toEqual(["getClaims", "getClaims"]);
  });
});

describe("getSession yields no access token", () => {
  it.each([
    ["no session", { data: { session: null }, error: null }],
    ["a refresh error", { data: { session: null }, error: new AuthRetryableFetchError("down", 503) }],
    ["an empty token", { data: { session: { access_token: "" } }, error: null }],
  ])("%s: no getUser, nothing revoked, /login renders", async (_l, result) => {
    getSessionMock.mockImplementation(async () => { await probe("getSession"); return result; });
    const res = await proxy(req("/login"));
    expect(getUserMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(adminSignOutMock).not.toHaveBeenCalled();
    expect(location(res)).toBeNull();
  });
});
