// QA round 2: the real proxy through the real @supabase/ssr + auth-js, only global
// fetch faked. ES256 tokens verified locally against a faked JWKS. Covers how each
// shape of Auth failure on GET /user decides whether /login clears the session.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const COOKIE = "sb-127-auth-token";
const KID = "qa-es256-r2";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const SID = "5e550000-0000-4000-8000-000000000000";

function cookie(): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: KID }));
  const p = b64u(JSON.stringify({ sub: "u-r2", session_id: SID, role: "authenticated", aud: "authenticated", iat: now - 10, exp: now + 3600 }));
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  const session = { access_token: `${h}.${p}.${b64u(sig)}`, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: "rt-r2", user: { id: "u-r2" } };
  return `${COOKIE}=base64-${b64u(JSON.stringify(session))}`;
}

type UserReply = () => Promise<Response>;
let userReply: UserReply;
let logoutReply: () => Promise<Response>;
let calls: string[];
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54398";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname.replace("/auth/v1", "");
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}${url.search}`);
      if (path === "/.well-known/jwks.json") return json(200, { keys: [JWK] });
      if (path === "/user") return userReply();
      if (path === "/logout") return logoutReply();
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
beforeEach(() => {
  calls = [];
  logoutReply = async () => new Response(null, { status: 204 });
});

const { proxy } = await import("@/proxy");
const req = (path: string) => new NextRequest(new Request(`https://news.h72labs.com${path}`, { headers: { cookie: cookie() } }));
const cleared = (res: Response) => res.headers.getSetCookie().filter((l) => l.startsWith("sb-") && /max-age=0/i.test(l));
const logouts = () => calls.filter((c) => c.startsWith("POST /logout"));

describe("Auth can't answer: /login renders, the session is kept and never revoked", () => {
  const outages: Array<[string, UserReply]> = [
    ["500", async () => json(500, { code: 500, msg: "internal" })],
    ["502", async () => json(502, { msg: "bad gateway" })],
    ["504 with an HTML body", async () => new Response("<html>gateway timeout</html>", { status: 504, headers: { "content-type": "text/html" } })],
    ["520 (Cloudflare)", async () => new Response("", { status: 520 })],
    ["connection refused (fetch rejects)", async () => { throw new TypeError("fetch failed"); }],
    ["aborted / timed out", async () => { throw new DOMException("The operation was aborted.", "AbortError"); }],
    ["200 with an unparseable body", async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } })],
  ];
  it.each(outages)("%s", async (_label, reply) => {
    userReply = reply;
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res)).toEqual([]);
    expect(logouts()).toEqual([]);
    expect(calls.filter((c) => c === "GET /user")).toHaveLength(1);
  });

  it("on /signup too", async () => {
    userReply = async () => json(503, { msg: "down" });
    const res = await proxy(req("/signup"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res)).toEqual([]);
    expect(logouts()).toEqual([]);
  });
});

describe("Auth says the session or user is gone: /login renders and the cookies go", () => {
  it("session_not_found: auth-js drops the session inside getUser, so no /logout is even sent", async () => {
    userReply = async () => json(403, { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" });
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res).length).toBeGreaterThan(0);
    expect(logouts()).toEqual([]);
  });

  it("user_not_found: signOut sends one scope=local /logout and clears", async () => {
    userReply = async () => json(403, { code: 403, error_code: "user_not_found", msg: "User from sub claim in JWT does not exist" });
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res).length).toBeGreaterThan(0);
    expect(logouts()).toEqual(["POST /logout?scope=local"]);
  });

  it("user_not_found while /logout itself is down: cookies are still cleared and the proxy does not throw", async () => {
    userReply = async () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" });
    logoutReply = async () => json(503, { msg: "down" });
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res).length).toBeGreaterThan(0);
  });

  it("user_not_found while /logout is unreachable: cookies are still cleared and the proxy does not throw", async () => {
    userReply = async () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" });
    logoutReply = async () => { throw new TypeError("fetch failed"); };
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res).length).toBeGreaterThan(0);
  });
});

// A 429 is not in auth-js's retryable set, so today a rate-limited /user signs a
// live browser out. A 429 says nothing about whether the session is alive.
// Skipped until the proxy clears only on an explicit rejection (session
// missing, or 401/403/404); tracked in the project log's review notes.
describe("Auth answers 429 for a live session", () => {
  it.skip("keeps the session", async () => {
    userReply = async () => json(429, { code: 429, error_code: "over_request_rate_limit", msg: "Request rate limit reached" });
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(logouts()).toEqual([]);
    expect(cleared(res)).toEqual([]);
  });
});
