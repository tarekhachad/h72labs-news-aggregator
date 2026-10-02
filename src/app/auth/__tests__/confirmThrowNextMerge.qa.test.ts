// /auth/confirm when signOut throws, with Next's REAL route-handler cookie
// plumbing: the cookie store is Next's MutableRequestCookiesAdapter, and the
// final Set-Cookie lines come from Next's own appendMutableCookies, the step
// that merges the store's writes into the response the handler returned.
// Only global fetch and signOut's throw are faked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestCookies } from "next/dist/compiled/@edge-runtime/cookies";
import {
  MutableRequestCookiesAdapter,
  appendMutableCookies,
} from "next/dist/server/web/spec-extension/adapters/request-cookies";

let store: ReturnType<typeof MutableRequestCookiesAdapter.wrap>;
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => store) }));

let signOutThrows = true;
vi.mock("@/lib/supabase/server", async () => {
  const real = await vi.importActual<typeof import("@/lib/supabase/server")>("@/lib/supabase/server");
  return {
    createClient: async () => {
      const client = await real.createClient();
      const original = client.auth.signOut.bind(client.auth);
      client.auth.signOut = (async (...args: Parameters<typeof original>) => {
        if (signOutThrows) throw new Error("lock acquisition timed out");
        return original(...args);
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
  const payload = { sub: "u-merge", session_id: "c0f30000-0000-4000-8000-000000000000", role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 };
  return {
    access_token: `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${b64u(JSON.stringify(payload))}.sig`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "rt-merge",
    user: { id: "u-merge", aud: "authenticated", role: "authenticated", ...extraUser },
  };
}
let session: ReturnType<typeof verifiedSession>;
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54393";
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
  if (savedEnv.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = savedEnv.url;
  if (savedEnv.key === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
  else process.env.SUPABASE_PUBLISHABLE_KEY = savedEnv.key;
});

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  signOutThrows = true;
  session = verifiedSession();
  errSpy?.mockRestore();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

const { GET } = await import("@/app/auth/confirm/route");

// Runs the route as Next would, and returns the Set-Cookie lines the browser
// receives, after Next has merged the store's writes into the response.
async function confirmAsNext(requestCookie = ""): Promise<{ location: string | null; setCookie: string[] }> {
  store = MutableRequestCookiesAdapter.wrap(new RequestCookies(new Headers(requestCookie ? { cookie: requestCookie } : {})));
  const res = await GET(new Request(`${ORIGIN}/auth/confirm?token_hash=abc&type=email`));
  const headers = new Headers(res.headers);
  appendMutableCookies(headers, store);
  return { location: res.headers.get("location"), setCookie: headers.getSetCookie() };
}
const linesFor = (setCookie: string[], name: string) => setCookie.filter((l) => l.startsWith(`${name}=`));
// How a browser reads a line: Max-Age=0, or an Expires in the past, removes it.
function expires(line: string): boolean {
  if (/;\s*max-age=0(;|$)/i.test(line)) return true;
  const at = /;\s*expires=([^;]+)/i.exec(line)?.[1];
  return at !== undefined && new Date(at).getTime() <= Date.now();
}
// A browser keeps a cookie unless the one line it gets for that name expires it.
const keptSessionCookies = (setCookie: string[]) =>
  setCookie.filter((l) => l.startsWith("sb-") && !expires(l)).map((l) => l.slice(0, l.indexOf("=")));

describe("signOut throwing on a confirmation link, through Next's real cookie merge", () => {
  it("the browser receives one expiring line for the session cookie, not the session verifyOtp wrote", async () => {
    const { location, setCookie } = await confirmAsNext();
    expect(location).toBe(`${ORIGIN}/login?confirmed=1`);
    const lines = linesFor(setCookie, OURS);
    expect(lines).toHaveLength(1);
    expect(expires(lines[0])).toBe(true);
    expect(lines[0]).toMatch(/path=\/(;|$)/i);
    expect(keptSessionCookies(setCookie)).toEqual([]);
  });

  it("a chunked session: every chunk's only line expires it", async () => {
    session = verifiedSession({ user_metadata: { blob: "x".repeat(9000) } });
    const { setCookie } = await confirmAsNext();
    const chunks = setCookie.filter((l) => /^sb-127-auth-token\.\d+=/.test(l));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(expires)).toBe(true);
    expect(keptSessionCookies(setCookie)).toEqual([]);
  });

  it("a browser arriving with a stale chunk from an older, bigger session has that chunk expired too", async () => {
    const { setCookie } = await confirmAsNext(`${OURS}.0=old0; ${OURS}.1=old1; ${OURS}.2=old2`);
    for (const name of [OURS, `${OURS}.2`]) {
      const lines = linesFor(setCookie, name);
      expect(lines).toHaveLength(1);
      expect(expires(lines[0])).toBe(true);
    }
    expect(keptSessionCookies(setCookie)).toEqual([]);
  });

  it("another project's cookie the browser sent is not touched", async () => {
    const { setCookie } = await confirmAsNext("sb-otherref-auth-token=theirs; theme=dark");
    expect(linesFor(setCookie, "sb-otherref-auth-token")).toEqual([]);
    expect(linesFor(setCookie, "theme")).toEqual([]);
  });

  it("when signOut works, the store's own clears reach the browser and the route adds none", async () => {
    signOutThrows = false;
    const { setCookie } = await confirmAsNext();
    expect(keptSessionCookies(setCookie)).toEqual([]);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
