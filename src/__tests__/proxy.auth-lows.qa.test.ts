// QA: the real proxy through the real @supabase/ssr +
// auth-js, only global fetch faked. The fake fetch behaves like a real one with
// respect to abort signals: an already-aborted signal rejects at once, and a
// pending reply rejects the moment its signal fires. Some cases run in real
// time against the 5-second deadline.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const DEADLINE_MS = 5000;
const SLOW = DEADLINE_MS + 6000;

const COOKIE = "sb-127-auth-token";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const SID = "a0a00000-0000-4000-8000-000000000000";

// Every token gets its own kid unless told otherwise, so auth-js's JWKS cache
// never hides a JWKS fetch from a test that needs to see one.
let kidSeq = 0;
const freshKid = () => `qa-lows-${++kidSeq}`;
const jwk = (kid: string) => ({ ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" });
let servedKids: string[] = [];

function accessToken(expiresIn: number, kid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const p = b64u(JSON.stringify({ sub: "u-lows", session_id: SID, role: "authenticated", aud: "authenticated", iat: now - 10, exp: now + expiresIn }));
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64u(sig)}`;
}

function session(expiresIn: number, kid: string, rt = "rt-lows") {
  const now = Math.floor(Date.now() / 1000);
  return { access_token: accessToken(expiresIn, kid), token_type: "bearer", expires_in: expiresIn, expires_at: now + expiresIn, refresh_token: rt, user: { id: "u-lows" } };
}

function cookie(expiresIn = 3600, kid = freshKid()): string {
  servedKids.push(kid);
  return `${COOKIE}=base64-${b64u(JSON.stringify(session(expiresIn, kid)))}`;
}

type Sig = AbortSignal | null | undefined;
type Reply = (signal: Sig) => Promise<Response>;
let userReply: Reply;
let logoutReply: Reply;
let tokenReply: Reply;
let jwksDelayMs: number;
let calls: Array<{ call: string; signal: Sig; at: number }>;
let t0: number;
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const html = (s: number) => new Response("<html><body>blocked</body></html>", { status: s, headers: { "content-type": "text/html" } });

// Resolves with `value` after `ms`, unless the signal fires first (then rejects
// with its reason, like real fetch).
function after(ms: number, value: () => Response): Reply {
  return (signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(() => resolve(value()), ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
    });
}
const hang: Reply = (signal) =>
  new Promise((_r, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54391";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname.replace("/auth/v1", "");
      const signal = init?.signal;
      calls.push({ call: `${(init?.method ?? "GET").toUpperCase()} ${path}${url.search}`, signal, at: performance.now() - t0 });
      // A real fetch given an already-aborted signal rejects before sending.
      if (signal?.aborted) throw signal.reason;
      if (path === "/.well-known/jwks.json") {
        return after(jwksDelayMs, () => json(200, { keys: servedKids.map(jwk) }))(signal);
      }
      if (path === "/token") return tokenReply(signal);
      if (path === "/user") return userReply(signal);
      if (path === "/logout") return logoutReply(signal);
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
  servedKids = [];
  jwksDelayMs = 0;
  t0 = performance.now();
  userReply = async () => json(200, { id: "u-lows", aud: "authenticated", role: "authenticated" });
  logoutReply = async () => new Response(null, { status: 204 });
  tokenReply = async () => json(200, session(3600, servedKids[servedKids.length - 1] ?? "none", "rt-rotated"));
});

const { proxy } = await import("@/proxy");
const req = (path: string, c = cookie(), method = "GET") =>
  new NextRequest(new Request(`https://news.h72labs.com${path}`, { method, headers: { cookie: c } }));
const cleared = (res: Response) => res.headers.getSetCookie().filter((l) => l.startsWith("sb-") && /max-age=0/i.test(l));
const callsTo = (prefix: string) => calls.filter((c) => c.call.startsWith(prefix));
const logouts = () => callsTo("POST /logout");

async function timed(path: string, c?: string) {
  t0 = performance.now();
  const res = await proxy(req(path, c));
  return { res, elapsed: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
describe("status matrix on GET /user for /login: only 401/403/404 (JSON from Auth) or a missing session clear", () => {
  const rejected: Array<[string, () => Response]> = [
    ["401 bad_jwt", () => json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" })],
    ["401 no error code", () => json(401, { msg: "unauthorized" })],
    ["403 bad_jwt", () => json(403, { code: 403, error_code: "bad_jwt", msg: "token is expired" })],
    ["403 user_not_found", () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" })],
    ["404 user_not_found", () => json(404, { code: 404, error_code: "user_not_found", msg: "User not found" })],
    ["404 no error code", () => json(404, { msg: "not found" })],
  ];
  it.each(rejected)("%s: /login renders, cookies cleared, one scope=local /logout", async (_l, reply) => {
    userReply = async () => reply();
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res).length).toBeGreaterThan(0);
    expect(logouts().map((c) => c.call)).toEqual(["POST /logout?scope=local"]);
  });

  it("403 session_not_found: cleared by auth-js inside getUser, no /logout", async () => {
    userReply = async () => json(403, { code: 403, error_code: "session_not_found", msg: "Session not found" });
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res).length).toBeGreaterThan(0);
    expect(logouts()).toEqual([]);
  });

  const kept: Array<[string, () => Response]> = [
    ["400 validation_failed", () => json(400, { code: 400, error_code: "validation_failed", msg: "bad" })],
    ["400 no code", () => json(400, { msg: "bad request" })],
    ["405", () => json(405, { msg: "method not allowed" })],
    ["409 conflict", () => json(409, { code: 409, error_code: "conflict", msg: "conflict" })],
    ["410", () => json(410, { msg: "gone" })],
    ["422 unexpected_failure", () => json(422, { code: 422, error_code: "unexpected_failure", msg: "x" })],
    ["429 over_request_rate_limit", () => json(429, { code: 429, error_code: "over_request_rate_limit", msg: "slow down" })],
    ["429 with an empty body", () => new Response("", { status: 429 })],
    ["401 HTML (not Auth)", () => html(401)],
    ["403 HTML (WAF)", () => html(403)],
    ["404 HTML (wrong host / route)", () => html(404)],
    ["401 empty body", () => new Response("", { status: 401 })],
    ["403 truncated JSON", () => new Response('{"code":403,"error_co', { status: 403, headers: { "content-type": "application/json" } })],
    ["500", () => json(500, { msg: "x" })],
    ["503 HTML", () => html(503)],
    ["530 (Cloudflare)", () => new Response("", { status: 530 })],
    ["599 (non-standard 5xx, not in auth-js's retryable list)", () => json(599, { msg: "x" })],
    ["200 HTML (captive portal)", () => html(200)],
  ];
  it.each(kept)("%s: /login renders, cookies kept, nothing revoked", async (_l, reply) => {
    userReply = async () => reply();
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res)).toEqual([]);
    expect(res.headers.getSetCookie().filter((l) => l.startsWith("sb-"))).toEqual([]);
    expect(logouts()).toEqual([]);
    expect(callsTo("GET /user")).toHaveLength(1);
  });

  it.each(["/login", "/signup"])("a live user on %s is redirected to / with cookies untouched", async (path) => {
    const res = await proxy(req(path));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(cleared(res)).toEqual([]);
    expect(logouts()).toEqual([]);
  });

  it("a live user's redirect keeps nothing of /login's query but goes to exactly /", async () => {
    const res = await proxy(req("/login?confirmed=1"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/");
  });

  it("the sign-in form POST to /login with a token whose user is gone is not bounced", async () => {
    userReply = async () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" });
    const res = await proxy(req("/login", cookie(), "POST"));
    expect(res.headers.get("location")).toBeNull();
    expect(cleared(res).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("the 5-second deadline on /login and /signup", () => {
  it(
    "is ONE shared deadline: a 3s GET /user that rejects, then a hanging /logout, ends at ~5s total (not 3s + 5s)",
    async () => {
      userReply = after(3000, () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" }));
      logoutReply = hang;
      const { res, elapsed } = await timed("/login");
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(DEADLINE_MS + 800);
      expect(res.headers.get("location")).toBeNull();
      expect(cleared(res).length).toBeGreaterThan(0);
      // the /logout went out with the same signal as GET /user
      expect(logouts()[0].signal).toBe(callsTo("GET /user")[0].signal);
    },
    SLOW
  );

  it(
    "a slow but in-time answer (4s, live user) is honoured: redirect to /",
    async () => {
      userReply = after(4000, () => json(200, { id: "u-lows", aud: "authenticated", role: "authenticated" }));
      const { res, elapsed } = await timed("/login");
      expect(elapsed).toBeGreaterThanOrEqual(3950);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    },
    SLOW
  );

  it(
    "Auth sends headers and then stalls the body: the deadline still ends it, cookies kept",
    async () => {
      userReply = async (signal) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"u-lo'));
            signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      };
      const { res, elapsed } = await timed("/signup");
      expect(elapsed).toBeLessThan(DEADLINE_MS + 800);
      expect(res.headers.get("location")).toBeNull();
      expect(cleared(res)).toEqual([]);
      expect(logouts()).toEqual([]);
    },
    SLOW
  );

  it(
    "the rejection arrives just as the deadline fires: /logout is aborted before sending, cookies are still cleared, no throw",
    async () => {
      // Resolves exactly when the signal aborts, as if the answer and the timer raced.
      userReply = (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(json(401, { code: 401, error_code: "bad_jwt", msg: "x" })), { once: true });
        });
      const { res, elapsed } = await timed("/login");
      expect(elapsed).toBeLessThan(DEADLINE_MS + 800);
      expect(res.headers.get("location")).toBeNull();
      expect(cleared(res).length).toBeGreaterThan(0);
      expect(logouts()).toHaveLength(1);
      expect(logouts()[0].signal?.aborted).toBe(true);
    },
    SLOW
  );

  it(
    "a timed-out GET /user on /signup with a 30s-from-expiry token: refresh happens first, without the deadline, then /user times out and cookies (the refreshed ones) are kept",
    async () => {
      userReply = hang;
      const { res, elapsed } = await timed("/signup", cookie(30));
      expect(elapsed).toBeLessThan(DEADLINE_MS + 800);
      expect(res.headers.get("location")).toBeNull();
      expect(callsTo("POST /token")).toHaveLength(1);
      expect(callsTo("POST /token").every((c) => c.signal === undefined)).toBe(true);
      expect(cleared(res)).toEqual([]);
      expect(logouts()).toEqual([]);
    },
    SLOW
  );
});

// ---------------------------------------------------------------------------
describe("where the deadline must NOT go", () => {
  it("a JWKS fetch that has to happen (unknown kid) during /login carries no signal", async () => {
    await proxy(req("/login"));
    expect(callsTo("GET /.well-known/jwks.json").length).toBeGreaterThan(0);
    expect(callsTo("GET /.well-known/jwks.json").every((c) => c.signal === undefined)).toBe(true);
    expect(callsTo("GET /user")[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("every POST /token on /login carries no signal (not just the first), and there is exactly one", async () => {
    await proxy(req("/login", cookie(30)));
    expect(callsTo("POST /token")).toHaveLength(1);
    expect(callsTo("POST /token").every((c) => c.signal === undefined)).toBe(true);
  });

  // auth-js retries a 503 refresh with backoff for about 25 s of its own
  // sleeps. Faked clocks run that loop in full without the wait; the deadline
  // is never armed on this path, so its real timer doesn't matter here.
  it("a refresh that fails with 503 inside getClaims is not retried under the deadline by getUser", async () => {
    tokenReply = async () => json(503, { msg: "down" });
    const c = cookie(30);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let settled = false;
      const done = proxy(req("/login", c)).finally(() => (settled = true));
      for (let step = 0; step < 120 && !settled; step++) await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(true);
      await done;
    } finally {
      vi.useRealTimers();
    }
    // The whole backoff ran: 200 ms doubling while it still fits auth-js's 30 s window.
    expect(callsTo("POST /token")).toHaveLength(8);
    expect(callsTo("POST /token").every((c) => c.signal === undefined)).toBe(true);
    // Only GET /user runs under the deadline, after every refresh attempt.
    expect(calls.filter((c) => c.signal).map((c) => c.call)).toEqual(["GET /user"]);
    expect(calls.findLastIndex((c) => c.call.startsWith("POST /token"))).toBeLessThan(calls.findIndex((c) => c.signal));
  });

  it.each(["/", "/profile", "/reset-password", "/forgot-password", "/auth/confirm", "/api/digest", "/login-foo", "/signup/check-email"])(
    "no Auth call on %s carries a signal, refresh included",
    async (path) => {
      await proxy(req(path, cookie(30)));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.signal === undefined)).toBe(true);
    }
  );

  it("does not leak from one request to the next: /login then / (with a refresh) on the same module", async () => {
    await proxy(req("/login"));
    expect(callsTo("GET /user")[0].signal).toBeInstanceOf(AbortSignal);
    calls = [];
    await proxy(req("/", cookie(30)));
    expect(callsTo("POST /token")).toHaveLength(1);
    expect(calls.every((c) => c.signal === undefined)).toBe(true);
  });

  it("a visitor with no token on /login makes no Auth call at all", async () => {
    const res = await proxy(new NextRequest(new Request("https://news.h72labs.com/login")));
    expect(calls).toEqual([]);
    expect(res.headers.get("location")).toBeNull();
  });

  // The token crosses auth-js's 90-second refresh margin between getClaims (no
  // refresh needed yet) and getUser (now needs one). getUser's own
  // __loadSession then refreshes -- after the deadline is armed.
  it(
    "a token that crosses the 90s refresh margin during getClaims is refreshed by getUser WITHOUT the deadline",
    async () => {
      jwksDelayMs = 1500;
      await proxy(req("/login", cookie(91)));
      const tokens = callsTo("POST /token");
      expect(tokens.length).toBeGreaterThan(0); // the refresh did happen inside getUser
      expect(tokens.every((c) => c.signal === undefined)).toBe(true);
    },
    SLOW
  );

  it(
    "a token that crosses the 90s margin while GET /user is in flight is revoked without a refresh, and the cookies go",
    async () => {
      userReply = after(2500, () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" }));
      const res = await proxy(req("/login", cookie(91)));
      expect(callsTo("POST /token")).toEqual([]);
      expect(logouts()).toHaveLength(1);
      expect(cleared(res).length).toBeGreaterThan(0);
    },
    SLOW
  );
});

// A refresh of a live session is never cut off, even a slow one: it finishes,
// the rotated token reaches the browser, and only then does the bounded check run.
describe("a slow refresh on /login is allowed to finish", () => {
  it(
    "the refresh is not aborted and the rotated session is written",
    async () => {
      jwksDelayMs = 1500;
      const kid = freshKid();
      tokenReply = after(DEADLINE_MS + 1000, () => json(200, session(3600, kid, "rt-rotated")));
      userReply = async () => json(503, { msg: "down" });
      servedKids.push(kid);
      const { res, elapsed } = await timed("/login", cookie(91));
      const tokens = callsTo("POST /token");
      expect(res.headers.get("location")).toBeNull();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].signal).toBeUndefined();
      expect(elapsed).toBeGreaterThan(DEADLINE_MS + 1000);
      expect(res.headers.getSetCookie().some((l) => l.startsWith("sb-") && !/max-age=0/i.test(l))).toBe(true);
      expect(callsTo("GET /user")[0].at).toBeGreaterThan(tokens[0].at);
      expect(callsTo("GET /user")[0].signal).toBeInstanceOf(AbortSignal);
    },
    SLOW + 5000
  );
});
