// QA round 1: /auth/confirm's signOut-throws path for the throw points the
// shipped tests do not cover, through Next's REAL route-handler cookie
// plumbing (MutableRequestCookiesAdapter + appendMutableCookies). Real
// @supabase/ssr and auth-js; only global fetch and the throw are faked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestCookies } from "next/dist/compiled/@edge-runtime/cookies";
import {
  MutableRequestCookiesAdapter,
  appendMutableCookies,
} from "next/dist/server/web/spec-extension/adapters/request-cookies";

let store: ReturnType<typeof MutableRequestCookiesAdapter.wrap>;
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => store) }));

// "before": throws before signOut runs. "after": signOut finishes (cookies
// removed in the store), then throws. "none": signOut runs normally.
let mode: "before" | "after" | "none" = "before";
vi.mock("@/lib/supabase/server", async () => {
  const real = await vi.importActual<typeof import("@/lib/supabase/server")>("@/lib/supabase/server");
  return {
    createClient: async () => {
      const client = await real.createClient();
      const original = client.auth.signOut.bind(client.auth);
      client.auth.signOut = (async (...args: Parameters<typeof original>) => {
        if (mode === "before") throw new Error("lock acquisition timed out");
        const out = await original(...args);
        if (mode === "after") throw new Error("thrown after removal");
        return out;
      }) as typeof client.auth.signOut;
      return client;
    },
  };
});

const ORIGIN = "https://news.h72labs.com";
const OURS = "sb-127-auth-token";
const b64u = (s: string) => Buffer.from(s).toString("base64url");
function verifiedSession(extraUser: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: "u-modes", session_id: "d0d00000-0000-4000-8000-000000000000", role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 };
  return {
    access_token: `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${b64u(JSON.stringify(payload))}.sig`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "rt-modes",
    user: { id: "u-modes", aud: "authenticated", role: "authenticated", ...extraUser },
  };
}
let session: ReturnType<typeof verifiedSession>;
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY, secret: process.env.RECOVERY_MARKER_SECRET };
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54395";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/verify")) return json(200, session);
      if (url.pathname.endsWith("/logout")) return new Response(null, { status: 204 });
      return json(404, {});
    })
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of [["SUPABASE_URL", savedEnv.url], ["SUPABASE_PUBLISHABLE_KEY", savedEnv.key], ["RECOVERY_MARKER_SECRET", savedEnv.secret]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  mode = "before";
  session = verifiedSession();
  process.env.SUPABASE_URL = "http://127.0.0.1:54395";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const { GET } = await import("@/app/auth/confirm/route");

async function asNext(query: string, requestCookie = "") {
  store = MutableRequestCookiesAdapter.wrap(new RequestCookies(new Headers(requestCookie ? { cookie: requestCookie } : {})));
  const res = await GET(new Request(`${ORIGIN}/auth/confirm${query}`));
  const routeOwn = res.headers.getSetCookie();
  const headers = new Headers(res.headers);
  appendMutableCookies(headers, store);
  return { status: res.status, location: res.headers.get("location"), routeOwn, setCookie: headers.getSetCookie() };
}
function expires(line: string): boolean {
  if (/;\s*max-age=0(;|$)/i.test(line)) return true;
  const at = /;\s*expires=([^;]+)/i.exec(line)?.[1];
  return at !== undefined && new Date(at).getTime() <= Date.now();
}
// What a browser holds after applying the lines in order to what it sent.
function browserAfter(sent: string, setCookie: string[]): string[] {
  const held = new Set(sent ? sent.split(/;\s*/).map((p) => p.slice(0, p.indexOf("="))) : []);
  for (const l of setCookie) {
    const name = l.slice(0, l.indexOf("="));
    if (expires(l)) held.delete(name);
    else held.add(name);
  }
  return [...held].sort();
}

describe("signOut throwing AFTER it removed the session", () => {
  it("the browser ends with no session cookie, and the route adds no line the store did not need", async () => {
    mode = "after";
    const { location, routeOwn, setCookie } = await asNext("?token_hash=abc&type=email");
    expect(location).toBe(`${ORIGIN}/login?confirmed=1`);
    expect(browserAfter("", setCookie).filter((n) => n.startsWith("sb-"))).toEqual([]);
    // Every line the route itself set is an expiry.
    expect(routeOwn.every(expires)).toBe(true);
  });

  it("chunked session, thrown after removal: no chunk survives", async () => {
    mode = "after";
    session = verifiedSession({ user_metadata: { blob: "z".repeat(9000) } });
    const { setCookie } = await asNext("?token_hash=abc&type=email");
    expect(browserAfter("", setCookie).filter((n) => n.startsWith("sb-"))).toEqual([]);
  });
});

describe("signOut throwing BEFORE, with cookies the browser already held", () => {
  it("a browser already signed in as someone else ends with no session at all, other cookies kept", async () => {
    const sent = `${OURS}=base64-old; ${OURS}-code-verifier=v; sb-otherref-auth-token=theirs; theme=dark`;
    const { location, setCookie } = await asNext("?token_hash=abc&type=email", sent);
    expect(location).toBe(`${ORIGIN}/login?confirmed=1`);
    const held = browserAfter(sent, setCookie);
    expect(held).not.toContain(OURS);
    expect(held.filter((n) => /^sb-127-auth-token(\.\d+)?$/.test(n))).toEqual([]);
    expect(held).toContain("sb-otherref-auth-token");
    expect(held).toContain("theme");
  });

  it("the expiry lines carry Path=/ and SameSite=Lax, and no Domain (so they replace what @supabase/ssr wrote)", async () => {
    const { routeOwn } = await asNext("?token_hash=abc&type=email");
    expect(routeOwn.length).toBeGreaterThan(0);
    for (const l of routeOwn) {
      expect(l).toMatch(/;\s*path=\/(;|$)/i);
      expect(l).toMatch(/;\s*samesite=lax/i);
      expect(l).not.toMatch(/domain=/i);
    }
  });
});

describe("paths the change must not touch", () => {
  it("a recovery link (secret set) never calls signOut and sets no expiry on its redirect", async () => {
    process.env.RECOVERY_MARKER_SECRET = "x".repeat(64);
    mode = "before"; // would throw if reached
    const { location, routeOwn } = await asNext("?token_hash=abc&type=recovery&next=/reset-password");
    expect(location).toBe(`${ORIGIN}/reset-password`);
    expect(routeOwn).toEqual([]);
  });

  it("a successful signOut adds no line of the route's own", async () => {
    mode = "none";
    const { routeOwn, setCookie } = await asNext("?token_hash=abc&type=email");
    expect(routeOwn).toEqual([]);
    expect(browserAfter("", setCookie).filter((n) => n.startsWith("sb-"))).toEqual([]);
  });

  it("a failed verifyOtp goes to link_expired with no cookie of the route's own", async () => {
    session = undefined as unknown as ReturnType<typeof verifiedSession>;
    const { location, routeOwn } = await asNext("?token_hash=abc&type=bogus");
    expect(location).toBe(`${ORIGIN}/login?error=link_expired`);
    expect(routeOwn).toEqual([]);
  });
});
