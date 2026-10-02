// The real proxy through the real @supabase/ssr + auth-js, only global fetch
// faked. A "hanging" Auth call never answers on its own and ends only when the
// request's abort signal fires, the way a real fetch does. These run in real
// time, so each hanging case takes the full five seconds.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const DEADLINE_MS = 5000;
const SLOW = { timeout: DEADLINE_MS + 5000 };

const COOKIE = "sb-127-auth-token";
const KID = "deadline-es256";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const SID = "dead1100-0000-4000-8000-000000000000";

function accessToken(expiresIn: number): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: KID }));
  const p = b64u(JSON.stringify({ sub: "u-dl", session_id: SID, role: "authenticated", aud: "authenticated", iat: now - 10, exp: now + expiresIn }));
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64u(sig)}`;
}

function session(expiresIn: number) {
  const now = Math.floor(Date.now() / 1000);
  return { access_token: accessToken(expiresIn), token_type: "bearer", expires_in: expiresIn, expires_at: now + expiresIn, refresh_token: "rt-dl", user: { id: "u-dl" } };
}

const cookie = (expiresIn = 3600) => `${COOKIE}=base64-${b64u(JSON.stringify(session(expiresIn)))}`;

type Reply = (signal: AbortSignal | null | undefined) => Promise<Response>;
let userReply: Reply;
let logoutReply: Reply;
let calls: Array<{ call: string; signal: AbortSignal | null | undefined }>;
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

// Never answers; rejects only when the caller's signal aborts, like real fetch.
const hang: Reply = (signal) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54397";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname.replace("/auth/v1", "");
      calls.push({ call: `${(init?.method ?? "GET").toUpperCase()} ${path}${url.search}`, signal: init?.signal });
      if (path === "/.well-known/jwks.json") return json(200, { keys: [JWK] });
      if (path === "/token") return json(200, session(3600));
      if (path === "/user") return userReply(init?.signal);
      if (path === "/logout") return logoutReply(init?.signal);
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
  userReply = async () => json(200, { id: "u-dl", aud: "authenticated", role: "authenticated" });
  logoutReply = async () => new Response(null, { status: 204 });
});

const { proxy } = await import("@/proxy");
const req = (path: string, c = cookie()) => new NextRequest(new Request(`https://news.h72labs.com${path}`, { headers: { cookie: c } }));
const cleared = (res: Response) => res.headers.getSetCookie().filter((l) => l.startsWith("sb-") && /max-age=0/i.test(l));
const signalOf = (prefix: string) => calls.find((c) => c.call.startsWith(prefix))?.signal;

async function timed(path: string) {
  const started = performance.now();
  const res = await proxy(req(path));
  return { res, elapsed: performance.now() - started };
}

describe("Auth stops answering on /login or /signup", () => {
  it.each(["/login", "/signup"])(
    "%s renders within the deadline, keeps the cookies and revokes nothing",
    async (path) => {
      userReply = hang;
      const { res, elapsed } = await timed(path);
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(DEADLINE_MS + 1000);
      expect(res.headers.get("location")).toBeNull();
      expect(cleared(res)).toEqual([]);
      expect(calls.filter((c) => c.call.startsWith("POST /logout"))).toEqual([]);
    },
    SLOW.timeout
  );

  it(
    "Auth rejects the user and then /logout hangs: still within the deadline, cookies cleared",
    async () => {
      userReply = async () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" });
      logoutReply = hang;
      const { res, elapsed } = await timed("/login");
      expect(elapsed).toBeLessThan(DEADLINE_MS + 1000);
      expect(res.headers.get("location")).toBeNull();
      expect(cleared(res).length).toBeGreaterThan(0);
    },
    SLOW.timeout
  );
});

describe("Which Auth calls the deadline covers", () => {
  it("GET /user on /login carries it; the JWKS fetch behind getClaims does not", async () => {
    const res = await proxy(req("/login"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(signalOf("GET /user")).toBeInstanceOf(AbortSignal);
    expect(signalOf("GET /.well-known/jwks.json")).toBeUndefined();
  });

  it("a token refresh behind getClaims is never given it", async () => {
    await proxy(req("/login", cookie(30)));
    expect(calls.map((c) => c.call)).toContain("POST /token?grant_type=refresh_token");
    expect(signalOf("POST /token")).toBeUndefined();
    expect(signalOf("GET /user")).toBeInstanceOf(AbortSignal);
  });

  it.each(["/", "/profile", "/signup/check-email"])("no Auth call on %s carries it", async (path) => {
    await proxy(req(path, cookie(30)));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.signal === undefined)).toBe(true);
  });
});
