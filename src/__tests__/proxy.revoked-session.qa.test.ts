// QA: drives the real proxy through the real @supabase/ssr + auth-js, with only
// global fetch faked. Tokens are ES256-signed and the fake serves the public key
// on the JWKS endpoint, so getClaims() verifies locally the way it does against a
// project with asymmetric signing keys (no silent getUser() fallback).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const SUPABASE_URL = "http://127.0.0.1:54399";
const COOKIE = "sb-127-auth-token";
const KID = "qa-es256";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };
const USER_ID = "11111111-1111-4111-8111-111111111111";

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function accessToken(sid: string, expOffset = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: KID }));
  const p = b64u(
    JSON.stringify({ sub: USER_ID, session_id: sid, role: "authenticated", aud: "authenticated", iat: now - 10, exp: now + expOffset })
  );
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64u(sig)}`;
}

function sessionCookies(sid: string, opts: { pad?: number; expOffset?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const expOffset = opts.expOffset ?? 3600;
  const session = {
    access_token: accessToken(sid, expOffset),
    token_type: "bearer",
    expires_in: expOffset,
    expires_at: now + expOffset,
    refresh_token: `rt-${sid}`,
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "qa@example.test", app_metadata: {}, user_metadata: opts.pad ? { pad: "x".repeat(opts.pad) } : {} },
  };
  const value = "base64-" + b64u(JSON.stringify(session));
  // Mirrors @supabase/ssr's chunking (3180 chars per cookie).
  if (value.length <= 3180) return `${COOKIE}=${value}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < value.length; i += 3180, n++) parts.push(`${COOKIE}.${n}=${value.slice(i, i + 3180)}`);
  return parts.join("; ");
}

type Mode = { user: "session-map" | "503" | "user_not_found"; logout: "ok" | "503" };
let mode: Mode;
let alive: Set<string>;
let calls: string[];

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const bearer = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
  let sid: string | null = null;
  try {
    sid = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()).session_id;
  } catch {}
  const path = url.pathname.replace("/auth/v1", "");
  calls.push(`${method} ${path}`);
  const json = (status: number, body: unknown) =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  if (path === "/.well-known/jwks.json") return json(200, { keys: [JWK] });
  if (path === "/user") {
    if (mode.user === "503") return json(503, { code: 503, msg: "upstream unavailable" });
    if (mode.user === "user_not_found") return json(403, { code: 403, error_code: "user_not_found", msg: "User from sub claim in JWT does not exist" });
    if (sid && alive.has(sid)) return json(200, { id: USER_ID, aud: "authenticated", role: "authenticated", email: "qa@example.test" });
    return json(403, { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" });
  }
  if (path === "/logout") {
    if (mode.logout === "503") return json(503, { code: 503, msg: "upstream unavailable" });
    if (!sid || !alive.has(sid)) return json(403, { code: 403, error_code: "session_not_found", msg: "session gone" });
    alive.delete(sid);
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  if (path === "/token") return json(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
  return json(404, { msg: `not faked: ${url.pathname}` });
}

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
beforeAll(() => {
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (savedEnv.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = savedEnv.url;
  if (savedEnv.key === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
  else process.env.SUPABASE_PUBLISHABLE_KEY = savedEnv.key;
});
beforeEach(() => {
  mode = { user: "session-map", logout: "ok" };
  alive = new Set();
  calls = [];
});

const { proxy } = await import("@/proxy");

function req(path: string, cookie?: string, method = "GET"): NextRequest {
  return new NextRequest(new Request(`https://news.h72labs.com${path}`, { method, headers: cookie ? { cookie } : {} }));
}
const locationPath = (res: Response) => {
  const l = res.headers.get("location");
  return l ? new URL(l).pathname : null;
};
const userCalls = () => calls.filter((c) => c === "GET /user").length;
/** name -> {value, maxAge} for every sb-* cookie the response sets */
function setCookies(res: Response): Record<string, { value: string; maxAge: string | null }> {
  const out: Record<string, { value: string; maxAge: string | null }> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    if (!name.startsWith("sb-")) continue;
    const ma = attrs.find((a) => /^max-age=/i.test(a));
    out[name] = { value: pair.slice(eq + 1), maxAge: ma ? ma.split("=")[1] : null };
  }
  return out;
}

const DEAD = "dead0000-0000-4000-8000-000000000000";
const LIVE = "11ve0000-0000-4000-8000-000000000000";

describe("revoked session (token verifies locally, Auth says the session is gone)", () => {
  it("getClaims really verifies locally: a revoked token on / is let through by the proxy with no /user call", async () => {
    const res = await proxy(req("/", sessionCookies(DEAD)));
    expect(calls).toContain("GET /.well-known/jwks.json");
    expect(userCalls()).toBe(0);
    expect(locationPath(res)).toBeNull();
  });

  it("a token with a forged signature is not treated as signed in", async () => {
    const good = accessToken(DEAD);
    const [h, p] = good.split(".");
    const forged = `${h}.${p}.${b64u(Buffer.alloc(64, 7))}`;
    const now = Math.floor(Date.now() / 1000);
    const value = "base64-" + b64u(JSON.stringify({ access_token: forged, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: "r", user: { id: USER_ID } }));
    const res = await proxy(req("/", `${COOKIE}=${value}`));
    expect(locationPath(res)).toBe("/login");
  });

  it.each(["/login", "/signup"])("%s renders (no redirect) and the dead cookie is cleared", async (path) => {
    const res = await proxy(req(path, sessionCookies(DEAD)));
    expect(locationPath(res)).toBeNull();
    expect(userCalls()).toBe(1);
    const sc = setCookies(res);
    expect(sc[COOKIE]).toEqual({ value: "", maxAge: "0" });
  });

  it("the page request is forwarded without the dead cookie", async () => {
    const res = await proxy(req("/login", sessionCookies(DEAD)));
    // NextResponse.next({ request }) forwards overridden request cookies in this header.
    expect(locationPath(res)).toBeNull();
    expect(res.headers.get("x-middleware-override-headers")).toContain("cookie");
    const forwarded = res.headers.get("x-middleware-request-cookie");
    expect(forwarded).not.toBeNull();
    expect(forwarded).not.toMatch(/sb-127-auth-token=base64-/);
  });

  it("a chunked session cookie has every chunk cleared", async () => {
    const cookie = sessionCookies(DEAD, { pad: 5000 });
    expect(cookie).toContain(`${COOKIE}.1=`);
    const res = await proxy(req("/login", cookie));
    expect(locationPath(res)).toBeNull();
    const sc = setCookies(res);
    expect(sc[`${COOKIE}.0`]?.maxAge).toBe("0");
    expect(sc[`${COOKIE}.1`]?.maxAge).toBe("0");
    expect(Object.values(sc).every((c) => c.maxAge === "0")).toBe(true);
  });

  it("a deleted user (403 user_not_found, not session_not_found) is also cleared, not looped", async () => {
    mode.user = "user_not_found";
    const res = await proxy(req("/login", sessionCookies(DEAD)));
    expect(locationPath(res)).toBeNull();
    expect(setCookies(res)[COOKIE]?.maxAge).toBe("0");
  });

  it("keeps the query string on /login", async () => {
    const res = await proxy(req("/login?error=link_expired", sessionCookies(DEAD)));
    expect(res.headers.get("location")).toBeNull();
  });

  it("the sign-in form POST to /login with dead cookies reaches the action (no bounce) with the cookie stripped", async () => {
    const res = await proxy(req("/login", sessionCookies(DEAD), "POST"));
    expect(locationPath(res)).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("live session", () => {
  it.each(["/login", "/signup"])("is still bounced off %s to /, with exactly one /user call", async (path) => {
    alive.add(LIVE);
    const res = await proxy(req(path, sessionCookies(LIVE)));
    expect(locationPath(res)).toBe("/");
    expect(userCalls()).toBe(1);
    expect(calls).not.toContain("POST /logout");
    expect(alive.has(LIVE)).toBe(true);
  });

  it.each(["/", "/profile", "/saved", "/history", "/reset-password", "/forgot-password", "/signup/check-email", "/api/digest", "/topic/tech-ai"])(
    "%s makes no /user call from the proxy",
    async (path) => {
      alive.add(LIVE);
      const res = await proxy(req(path, sessionCookies(LIVE)));
      expect(userCalls()).toBe(0);
      expect(calls).not.toContain("POST /logout");
      expect(locationPath(res)).toBeNull();
    }
  );

  it("/login-foo is not treated as /login (exact match)", async () => {
    alive.add(LIVE);
    await proxy(req("/login-foo", sessionCookies(LIVE)));
    expect(userCalls()).toBe(0);
  });
});

describe("logged-out visitor", () => {
  it.each(["/login", "/signup"])("%s makes no Auth call at all and sets no cookie", async (path) => {
    const res = await proxy(req(path));
    expect(calls).toEqual([]);
    expect(locationPath(res)).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("an expired token with a dead refresh token on /login: treated as logged out, no /user call", async () => {
    const res = await proxy(req("/login", sessionCookies(DEAD, { expOffset: -60 })));
    expect(locationPath(res)).toBeNull();
    expect(userCalls()).toBe(0);
  });
});
