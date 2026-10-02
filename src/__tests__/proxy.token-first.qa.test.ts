// QA: the getSession-then-getUser(token) sequence on /login and /signup.
// The real proxy through the real @supabase/ssr + auth-js; only global fetch is
// faked. The fake honours abort signals like a real fetch and records the
// Authorization header of every call, so a test can see WHICH token a call used.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const DEADLINE_MS = 5000;
const SLOW = DEADLINE_MS + 6000;

const COOKIE = "sb-127-auth-token";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const SID = "b1b10000-0000-4000-8000-000000000000";

let kidSeq = 0;
const freshKid = () => `qa-tf-${++kidSeq}`;
const jwk = (kid: string) => ({ ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" });
let servedKids: string[] = [];

function accessToken(expiresIn: number, kid: string, tag: string): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const p = b64u(JSON.stringify({ sub: "u-tf", session_id: SID, tag, role: "authenticated", aud: "authenticated", iat: now - 10, exp: now + expiresIn }));
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64u(sig)}`;
}
const tagOf = (jwt: string) => {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).tag as string;
  } catch {
    return null;
  }
};

function session(expiresIn: number, kid: string, opts: { rt?: string; tag?: string; pad?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: accessToken(expiresIn, kid, opts.tag ?? "original"),
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token: opts.rt ?? "rt-original",
    user: { id: "u-tf", aud: "authenticated", role: "authenticated", user_metadata: opts.pad ? { pad: "x".repeat(opts.pad) } : {} },
  };
}

// Mirrors @supabase/ssr's chunking (3180 chars per cookie).
function cookie(expiresIn = 3600, opts: { pad?: number } = {}): string {
  const kid = freshKid();
  servedKids.push(kid);
  const value = "base64-" + b64u(JSON.stringify(session(expiresIn, kid, opts)));
  if (value.length <= 3180) return `${COOKIE}=${value}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < value.length; i += 3180, n++) parts.push(`${COOKIE}.${n}=${value.slice(i, i + 3180)}`);
  return parts.join("; ");
}

type Sig = AbortSignal | null | undefined;
type Reply = (signal: Sig) => Promise<Response>;
let userReply: Reply;
let logoutReply: Reply;
let tokenReply: Reply;
let jwksDelayMs: number;
let calls: Array<{ call: string; signal: Sig; at: number; done?: number; bearer: string }>;
let t0: number;
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const LIVE_USER = () => json(200, { id: "u-tf", aud: "authenticated", role: "authenticated" });

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

// The session /token hands back: a distinct tag and refresh token, so a test
// can tell the rotated session from the original one.
let rotatedKid: string;
const rotated = (pad?: number) => json(200, session(3600, rotatedKid, { rt: "rt-rotated", tag: "rotated", pad }));

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54393";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname.replace("/auth/v1", "");
      const signal = init?.signal;
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      const rec = { call: `${(init?.method ?? "GET").toUpperCase()} ${path}${url.search}`, signal, at: performance.now() - t0, bearer } as (typeof calls)[number];
      calls.push(rec);
      if (signal?.aborted) throw signal.reason;
      const finish = (p: Promise<Response>) => p.finally(() => { rec.done = performance.now() - t0; });
      if (path === "/.well-known/jwks.json") return finish(after(jwksDelayMs, () => json(200, { keys: servedKids.map(jwk) }))(signal));
      if (path === "/token") return finish(tokenReply(signal));
      if (path === "/user") return finish(userReply(signal));
      if (path === "/logout") return finish(logoutReply(signal));
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
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls = [];
  servedKids = [];
  jwksDelayMs = 0;
  t0 = performance.now();
  rotatedKid = freshKid();
  servedKids.push(rotatedKid);
  userReply = async () => LIVE_USER();
  logoutReply = async () => new Response(null, { status: 204 });
  tokenReply = async () => rotated();
  warn = vi.spyOn(console, "warn");
});
afterEach(() => warn.mockRestore());

const { proxy } = await import("@/proxy");
const req = (path: string, c = cookie()) => new NextRequest(new Request(`https://news.h72labs.com${path}`, { headers: { cookie: c } }));
const sbSetCookies = (res: Response) => res.headers.getSetCookie().filter((l) => l.startsWith("sb-"));
const cleared = (res: Response) => sbSetCookies(res).filter((l) => /max-age=0/i.test(l));
const written = (res: Response) => sbSetCookies(res).filter((l) => !/max-age=0/i.test(l));
const callsTo = (prefix: string) => calls.filter((c) => c.call.startsWith(prefix));
const logouts = () => callsTo("POST /logout");
const location = (res: Response) => (res.headers.get("location") ? new URL(res.headers.get("location")!).pathname : null);

// The session the response leaves in the browser, decoded from its Set-Cookie
// lines (joined chunks). null when nothing was written.
function writtenSession(res: Response): { access_token: string; refresh_token: string } | null {
  const pairs = written(res).map((l) => l.split(";")[0]);
  if (!pairs.length) return null;
  const byName = new Map(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
  const whole = byName.get(COOKIE) ?? [...byName.keys()].filter((k) => k.startsWith(`${COOKIE}.`)).sort((a, b) => Number(a.split(".").pop()) - Number(b.split(".").pop())).map((k) => byName.get(k)).join("");
  return JSON.parse(Buffer.from(decodeURIComponent(whole).replace(/^base64-/, ""), "base64url").toString());
}

// The session the browser holds after applying the response's Set-Cookie
// lines to the cookies it sent.
function jarSession(sent: string, res: Response): { access_token: string; refresh_token: string } | null {
  const jar = new Map(sent.split("; ").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
  for (const l of sbSetCookies(res)) {
    const pair = l.split(";")[0];
    const name = pair.slice(0, pair.indexOf("="));
    if (/max-age=0/i.test(l)) jar.delete(name);
    else jar.set(name, decodeURIComponent(pair.slice(pair.indexOf("=") + 1)));
  }
  const whole = jar.get(COOKIE) ?? [...jar.keys()].filter((k) => k.startsWith(`${COOKIE}.`)).sort((a, b) => Number(a.split(".").pop()) - Number(b.split(".").pop())).map((k) => jar.get(k)).join("");
  if (!whole) return null;
  return JSON.parse(Buffer.from(whole.replace(/^base64-/, ""), "base64url").toString());
}

async function timed(path: string, c?: string) {
  t0 = performance.now();
  const res = await proxy(req(path, c));
  return { res, elapsed: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
describe("the token handed to GET /user", () => {
  it("is the cookie's access token, sent once, after getClaims, and nothing is refreshed", async () => {
    const res = await proxy(req("/login"));
    expect(location(res)).toBe("/");
    expect(callsTo("GET /user")).toHaveLength(1);
    expect(tagOf(callsTo("GET /user")[0].bearer)).toBe("original");
    expect(callsTo("POST /token")).toEqual([]);
    expect(callsTo("GET /user")[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("is the ROTATED token when the token crossed the 90s margin between getClaims and getSession, and the refresh finished before GET /user", async () => {
    jwksDelayMs = 1500;
    userReply = async () => json(503, { msg: "down" });
    const res = await proxy(req("/login", cookie(91)));
    const [token] = callsTo("POST /token");
    const [user] = callsTo("GET /user");
    expect(token.signal).toBeUndefined();
    expect(user.at).toBeGreaterThanOrEqual(token.done!);
    expect(tagOf(user.bearer)).toBe("rotated");
    // /login renders, and the rotated session reaches the browser.
    expect(location(res)).toBeNull();
    expect(writtenSession(res)?.refresh_token).toBe("rt-rotated");
    expect(cleared(res)).toEqual([]);
  }, SLOW);

  it("is the rotated token when getClaims itself refreshed (token already inside the margin)", async () => {
    userReply = async () => json(503, { msg: "down" });
    const res = await proxy(req("/login", cookie(30)));
    expect(callsTo("POST /token")).toHaveLength(1);
    expect(tagOf(callsTo("GET /user")[0].bearer)).toBe("rotated");
    expect(writtenSession(res)?.refresh_token).toBe("rt-rotated");
  });

  it("reading the session for its token does not trigger auth-js's insecure-user warning", async () => {
    await proxy(req("/login"));
    await proxy(req("/signup", cookie(30)));
    const insecure = warn.mock.calls.filter((a: unknown[]) => String(a[0]).includes("getSession()"));
    expect(insecure).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("a refresh inside the /login getSession that fails", () => {
  it("non-retryable (400 refresh_token_already_used), token still valid: session preserved, GET /user with the old token, live user redirected, nothing cleared, no second /token", async () => {
    jwksDelayMs = 1500;
    tokenReply = async () => json(400, { code: 400, error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" });
    const res = await proxy(req("/login", cookie(91)));
    expect(callsTo("POST /token")).toHaveLength(1);
    expect(callsTo("POST /token")[0].signal).toBeUndefined();
    expect(tagOf(callsTo("GET /user")[0].bearer)).toBe("original");
    expect(location(res)).toBe("/");
    expect(cleared(res)).toEqual([]);
    expect(logouts()).toEqual([]);
  }, SLOW);

  it("non-retryable refresh failure, then GET /user says session_not_found: cookies cleared, /login renders", async () => {
    jwksDelayMs = 1500;
    tokenReply = async () => json(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
    userReply = async () => json(403, { code: 403, error_code: "session_not_found", msg: "Session not found" });
    const res = await proxy(req("/login", cookie(91)));
    expect(location(res)).toBeNull();
    expect(cleared(res).length).toBeGreaterThan(0);
    expect(written(res)).toEqual([]);
  }, SLOW);

  it.each([
    ["429", () => json(429, { code: 429, error_code: "over_request_rate_limit", msg: "slow" })],
    ["400 validation", () => json(400, { code: 400, error_code: "validation_failed", msg: "x" })],
  ])("%s on the refresh and Auth down on GET /user: a live session is not signed out", async (_l, tok) => {
    jwksDelayMs = 1500;
    tokenReply = async () => tok();
    userReply = async () => json(503, { msg: "down" });
    const res = await proxy(req("/login", cookie(91)));
    expect(location(res)).toBeNull();
    expect(cleared(res)).toEqual([]);
    expect(logouts()).toEqual([]);
  }, SLOW);

  it(
    "retryable (503) refresh: every retry runs WITHOUT the deadline, then GET /user (old token, with the deadline) decides",
    async () => {
      jwksDelayMs = 1500;
      tokenReply = async () => json(503, { msg: "down" });
      const { res, elapsed } = await timed("/login", cookie(91));
      const tokens = callsTo("POST /token");
      expect(tokens.length).toBeGreaterThan(3);
      expect(tokens.every((c) => c.signal === undefined)).toBe(true);
      expect(callsTo("GET /user")).toHaveLength(1);
      expect(callsTo("GET /user")[0].at).toBeGreaterThan(tokens[tokens.length - 1].done!);
      expect(tagOf(callsTo("GET /user")[0].bearer)).toBe("original");
      expect(location(res)).toBe("/");
      expect(cleared(res)).toEqual([]);
      // Unbounded by design: auth-js retries a 5xx refresh for up to ~25s.
      console.info(`[qa] retryable refresh on /login took ${Math.round(elapsed)}ms over ${tokens.length} POST /token`);
    },
    45000
  );
});

// ---------------------------------------------------------------------------
describe("getClaims passed but getSession yields no token", () => {
  it("token expires between getClaims and getSession after a failed refresh: no GET /user, /login renders, nothing cleared or revoked", async () => {
    // getClaims: token is inside the margin, refresh 400s, token still valid so
    // the session is preserved; validateExp passes, then the JWKS fetch takes
    // long enough for the token to expire. getSession then sees the cached
    // failure on an expired token and returns no session.
    tokenReply = async () => json(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
    jwksDelayMs = 2600;
    const res = await proxy(req("/login", cookie(2)));
    expect(callsTo("POST /token")).toHaveLength(1);
    expect(callsTo("GET /user")).toEqual([]);
    expect(logouts()).toEqual([]);
    expect(location(res)).toBeNull();
    expect(calls.every((c) => c.signal === undefined)).toBe(true);
  }, SLOW);
});

// ---------------------------------------------------------------------------
describe("chunked session cookies", () => {
  it("a live user with a chunked session: GET /user gets the whole token, redirect to /", async () => {
    const c = cookie(3600, { pad: 5000 });
    expect(c).toContain(`${COOKIE}.1=`);
    const res = await proxy(req("/login", c));
    expect(tagOf(callsTo("GET /user")[0].bearer)).toBe("original");
    expect(location(res)).toBe("/");
  });

  it("chunked session and GET /user hangs: ~5s, every chunk kept, nothing written", async () => {
    userReply = hang;
    const { res, elapsed } = await timed("/login", cookie(3600, { pad: 5000 }));
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 800);
    expect(location(res)).toBeNull();
    expect(sbSetCookies(res)).toEqual([]);
  }, SLOW);

  it("chunked session crossing the margin: the rotated (chunked) session is written whole and GET /user uses it", async () => {
    jwksDelayMs = 1500;
    tokenReply = async () => rotated(5000);
    userReply = async () => json(503, { msg: "down" });
    const c = cookie(91, { pad: 5000 });
    const res = await proxy(req("/login", c));
    expect(tagOf(callsTo("GET /user")[0].bearer)).toBe("rotated");
    // @supabase/ssr writes only the chunks whose value changed, so read what
    // the browser ends up holding: its jar with the response applied.
    expect(written(res).length).toBeGreaterThan(0);
    expect(jarSession(c, res)?.refresh_token).toBe("rt-rotated");
  }, SLOW);

  it("chunked session rotated to a small one, then Auth rejects: no chunk is left with a value", async () => {
    jwksDelayMs = 1500;
    tokenReply = async () => rotated();
    userReply = async () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" });
    const res = await proxy(req("/login", cookie(91, { pad: 5000 })));
    expect(location(res)).toBeNull();
    expect(written(res)).toEqual([]);
    expect(cleared(res).length).toBeGreaterThan(0);
  }, SLOW);
});

// ---------------------------------------------------------------------------
describe("the redirect of a confirmed user after a refresh", () => {
  // FINDING (pre-existing, not introduced by 1884d39): the redirect to / is a
  // fresh NextResponse, so the rotated session getSession just wrote is not on
  // it. The browser keeps the replaced refresh token.
  it("documents current behaviour: the rotated session is NOT on the redirect to /", async () => {
    const res = await proxy(req("/login", cookie(30)));
    expect(callsTo("POST /token")).toHaveLength(1);
    expect(location(res)).toBe("/");
    expect(writtenSession(res)).toBeNull();
  });
});
