// QA: what revoking a token Auth rejected on /login sends, and exactly which
// cookies it expires, with the Set-Cookie lines a browser would apply.
// The real proxy through the real @supabase/ssr + auth-js; only global fetch is
// faked. The fake honours abort signals like a real fetch and records the
// Authorization header of every call, so a test can see WHICH token a call used.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const DEADLINE_MS = 5000;

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
let calls: Array<{ call: string; signal: Sig; at: number; done?: number; bearer: string; apikey: string }>;
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
  process.env.SUPABASE_URL = "http://127.0.0.1:54397";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname.replace("/auth/v1", "");
      const signal = init?.signal;
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      const rec = { call: `${(init?.method ?? "GET").toUpperCase()} ${path}${url.search}`, signal, at: performance.now() - t0, bearer, apikey: new Headers(init?.headers).get("apikey") ?? "" } as (typeof calls)[number];
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
const callsTo = (prefix: string) => calls.filter((c) => c.call.startsWith(prefix));
const logouts = () => callsTo("POST /logout");
const location = (res: Response) => (res.headers.get("location") ? new URL(res.headers.get("location")!).pathname : null);


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
// Helpers for the revoke + cookie-expiry checks.
const written = (res: Response) => sbSetCookies(res).filter((l) => !/max-age=0/i.test(l));
const REJECT = {
  401: () => json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" }),
  403: () => json(403, { code: 403, error_code: "user_not_found", msg: "User from sub claim in JWT does not exist" }),
  404: () => json(404, { code: 404, error_code: "user_not_found", msg: "User not found" }),
} as const;

// The access token inside the cookie string the browser sent (chunks joined).
function sentAccessToken(sent: string): string {
  const jar = new Map(sent.split("; ").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
  const whole = jar.get(COOKIE) ?? [...jar.keys()].filter((k) => /^sb-127-auth-token\.\d+$/.test(k)).sort((a, b) => Number(a.split(".").pop()) - Number(b.split(".").pop())).map((k) => jar.get(k)).join("");
  return JSON.parse(Buffer.from(whole!.replace(/^base64-/, ""), "base64url").toString()).access_token;
}
const tagOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).tag as string;
const setCookieNames = (res: Response) => res.headers.getSetCookie().map((l) => l.slice(0, l.indexOf("=")));
const clearedNames = (res: Response) => res.headers.getSetCookie().filter((l) => /max-age=0/i.test(l)).map((l) => l.slice(0, l.indexOf("="))).sort();
// The attributes that decide WHICH stored cookie a Set-Cookie line overwrites.
function scope(line: string) {
  const attrs = new Map<string, string | true>(
    line.split(";").slice(1).map((a) => a.trim()).filter(Boolean).map((a): [string, string | true] => {
      const i = a.indexOf("=");
      return i < 0 ? [a.toLowerCase(), true] : [a.slice(0, i).toLowerCase(), a.slice(i + 1).toLowerCase()];
    })
  );
  return { domain: attrs.get("domain") ?? null, path: attrs.get("path") ?? null, samesite: attrs.get("samesite") ?? null, secure: attrs.has("secure"), httponly: attrs.has("httponly") };
}

// ---------------------------------------------------------------------------
describe("the revoke request admin.signOut sends", () => {
  it.each([401, 403, 404] as const)(
    "on a %s from Auth: exactly one POST /logout?scope=local, bearer = the rejected token, apikey sent, same deadline signal as GET /user",
    async (status) => {
      userReply = async () => REJECT[status]();
      const sent = cookie();
      const res = await proxy(req("/login", sent));
      expect(location(res)).toBeNull();
      const [user] = callsTo("GET /user");
      const out = logouts();
      expect(out).toHaveLength(1);
      expect(out[0].call).toBe("POST /logout?scope=local");
      expect(out[0].bearer).toBe(sentAccessToken(sent));
      expect(out[0].bearer).toBe(user.bearer);
      expect(out[0].apikey).toBe("sb_publishable_dummy");
      expect(out[0].signal).toBeInstanceOf(AbortSignal);
      expect(out[0].signal).toBe(user.signal);
      expect(out[0].at).toBeGreaterThanOrEqual(user.done!);
      expect(callsTo("POST /token")).toEqual([]);
      expect(jarSession(sent, res)).toBeNull();
    }
  );

  it("a slow rejection then a hanging /logout: the shared deadline cuts /logout off, cookies still expire", async () => {
    userReply = after(3000, () => REJECT[401]());
    logoutReply = hang;
    const sent = cookie(3600, { pad: 5000 });
    const { res, elapsed } = await timed("/login", sent);
    expect(logouts()).toHaveLength(1);
    expect(logouts()[0].at).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 800);
    expect(jarSession(sent, res)).toBeNull();
  }, 20000);

  it("on /signup the same", async () => {
    userReply = async () => REJECT[403]();
    const sent = cookie();
    const res = await proxy(req("/signup", sent));
    expect(location(res)).toBeNull();
    expect(logouts()).toHaveLength(1);
    expect(jarSession(sent, res)).toBeNull();
  });

  it("after getSession rotated the session, the token revoked is the ROTATED one Auth rejected", async () => {
    jwksDelayMs = 1500; // token crosses the 90s margin between getClaims and getSession
    userReply = async () => REJECT[403]();
    const sent = cookie(91);
    const res = await proxy(req("/login", sent));
    expect(callsTo("POST /token")).toHaveLength(1);
    expect(tagOf(callsTo("GET /user")[0].bearer)).toBe("rotated");
    expect(tagOf(logouts()[0].bearer)).toBe("rotated");
    expect(jarSession(sent, res)).toBeNull();
  }, 20000);

  it.each([
    ["/logout answers 401 JSON (token already dead)", (async () => json(401, { code: 401, error_code: "bad_jwt", msg: "x" })) as Reply],
    ["/logout answers 500 HTML", (async () => new Response("<html>oops</html>", { status: 500, headers: { "content-type": "text/html" } })) as Reply],
    ["/logout's fetch rejects with a TypeError", (async () => { throw new TypeError("fetch failed"); }) as Reply],
  ])("%s: cookies still expire, proxy does not throw", async (_l, reply) => {
    userReply = async () => REJECT[403]();
    logoutReply = reply;
    const sent = cookie(3600, { pad: 5000 });
    const res = await proxy(req("/login", sent));
    expect(location(res)).toBeNull();
    expect(logouts()).toHaveLength(1);
    expect(jarSession(sent, res)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("which cookies the revoke expires", () => {
  it("a multi-chunk (3+) session: every chunk gets exactly one Max-Age=0 line, scoped like @supabase/ssr's own (Path=/, no Domain)", async () => {
    userReply = async () => REJECT[403]();
    const sent = cookie(3600, { pad: 8000 });
    expect(sent).toContain(`${COOKIE}.2=`);
    const res = await proxy(req("/login", sent));
    const sentNames = sent.split("; ").map((p) => p.slice(0, p.indexOf("="))).sort();
    expect(sentNames.length).toBeGreaterThanOrEqual(3);
    expect(clearedNames(res)).toEqual(sentNames);
    expect(new Set(setCookieNames(res)).size).toBe(setCookieNames(res).length);
    for (const l of cleared(res)) expect(scope(l)).toMatchObject({ domain: null, path: "/" });
    expect(jarSession(sent, res)).toBeNull();
  });

  it("a small session that a refresh grew into chunks, then rejected: chunks written earlier in this request are expired too, one line per name", async () => {
    jwksDelayMs = 1500;
    tokenReply = async () => rotated(8000);
    userReply = async () => REJECT[403]();
    const sent = cookie(91);
    expect(sent).not.toContain(`${COOKIE}.0=`);
    const res = await proxy(req("/login", sent));
    expect(tagOf(logouts()[0].bearer)).toBe("rotated");
    const names = setCookieNames(res);
    expect(new Set(names).size).toBe(names.length);
    expect(written(res)).toEqual([]);
    expect(clearedNames(res)).toEqual(expect.arrayContaining([COOKIE, `${COOKIE}.0`, `${COOKIE}.1`, `${COOKIE}.2`]));
    expect(jarSession(sent, res)).toBeNull();
  }, 20000);

  it("a stale chunk left beside a whole cookie is expired too", async () => {
    userReply = async () => REJECT[403]();
    const sent = `${cookie()}; ${COOKIE}.4=stale-junk`;
    const res = await proxy(req("/login", sent));
    expect(clearedNames(res)).toEqual([COOKIE, `${COOKIE}.4`]);
  });

  it("does not touch the PKCE verifier cookies, the -user key, or non-Supabase cookies", async () => {
    userReply = async () => REJECT[403]();
    const others = [
      `${COOKIE}-code-verifier=v1`,
      `${COOKIE}-flows-code-verifier=v2`,
      `${COOKIE}-flow-abcdefgh12-code-verifier=v3`,
      `${COOKIE}-user=v4`,
      "theme=dark",
      "sb-127-auth-tokenX=v5",
    ];
    const sent = `${cookie()}; ${others.join("; ")}`;
    const res = await proxy(req("/login", sent));
    expect(clearedNames(res)).toEqual([COOKIE]);
    for (const o of others) expect(setCookieNames(res)).not.toContain(o.slice(0, o.indexOf("=")));
  });

  it("DOCUMENTS: another project's session cookie on the same host is expired as well", async () => {
    userReply = async () => REJECT[403]();
    const sent = `${cookie()}; sb-otherref-auth-token=base64-eyJ9; sb-a-b-c-auth-token.0=x`;
    const res = await proxy(req("/login", sent));
    expect(clearedNames(res)).toEqual([COOKIE, "sb-a-b-c-auth-token.0", "sb-otherref-auth-token"]);
  });

  it("the expiry lines carry the same scope (Domain/Path/Secure/SameSite) as the lines @supabase/ssr writes the session with", async () => {
    // A protected page with a token inside the margin: getClaims refreshes and
    // ssr writes the rotated session with its own options.
    const write = await proxy(req("/", cookie(30)));
    const ssrLine = written(write)[0];
    expect(ssrLine).toBeDefined();
    userReply = async () => REJECT[403]();
    const clear = await proxy(req("/login", cookie()));
    const clearLine = cleared(clear)[0];
    const pick = ({ domain, path, samesite, secure }: ReturnType<typeof scope>) => ({ domain, path, samesite, secure });
    expect(pick(scope(clearLine))).toEqual(pick(scope(ssrLine)));
  });
});

// ---------------------------------------------------------------------------
describe("admin.signOut itself throwing (not an AuthError)", () => {
  it("DOCUMENTS what /login does", async () => {
    const { GoTrueAdminApi } = await import("@supabase/auth-js");
    const spy = vi.spyOn(GoTrueAdminApi.prototype, "signOut").mockRejectedValue(new Error("boom"));
    try {
      userReply = async () => REJECT[403]();
      const outcome = await proxy(req("/login", cookie())).then(
        (res) => ({ threw: false, cleared: cleared(res).length }),
        (e: Error) => ({ threw: true, message: e.message })
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({ threw: true, message: "boom" });
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
describe("errors that must not revoke or clear", () => {
  it.each([
    ["400 JSON", () => json(400, { code: 400, error_code: "validation_failed", msg: "x" })],
    ["422 JSON", () => json(422, { code: 422, error_code: "unexpected_failure", msg: "x" })],
    ["429 JSON", () => json(429, { code: 429, error_code: "over_request_rate_limit", msg: "x" })],
    ["401 HTML", () => new Response("<html>401</html>", { status: 401, headers: { "content-type": "text/html" } })],
    ["403 HTML", () => new Response("<html>403</html>", { status: 403, headers: { "content-type": "text/html" } })],
    ["502 JSON", () => json(502, { msg: "bad gateway" })],
  ])("%s on GET /user: no /logout, no cookie written", async (_l, r) => {
    userReply = async () => r();
    const res = await proxy(req("/login", cookie(3600, { pad: 5000 })));
    expect(location(res)).toBeNull();
    expect(logouts()).toEqual([]);
    expect(sbSetCookies(res)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("session_not_found: left to auth-js's own removal inside getUser", () => {
  const MISSING = () => json(403, { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" });

  it("a multi-chunk session: every chunk expired, no /logout, one line per name", async () => {
    userReply = async () => MISSING();
    const sent = cookie(3600, { pad: 8000 });
    const res = await proxy(req("/login", sent));
    expect(location(res)).toBeNull();
    expect(logouts()).toEqual([]);
    const sentNames = sent.split("; ").map((p) => p.slice(0, p.indexOf("="))).sort();
    expect(clearedNames(res)).toEqual(sentNames);
    expect(new Set(setCookieNames(res)).size).toBe(setCookieNames(res).length);
    expect(jarSession(sent, res)).toBeNull();
  });

  it("after a refresh grew the session into chunks in this request: no chunk keeps a value", async () => {
    jwksDelayMs = 1500;
    tokenReply = async () => rotated(8000);
    userReply = async () => MISSING();
    const sent = cookie(91);
    const res = await proxy(req("/login", sent));
    expect(callsTo("POST /token")).toHaveLength(1);
    expect(written(res)).toEqual([]);
    expect(jarSession(sent, res)).toBeNull();
  }, 20000);

  it("a stale chunk beside a whole cookie is expired too", async () => {
    userReply = async () => MISSING();
    const sent = `${cookie()}; ${COOKIE}.4=stale-junk`;
    const res = await proxy(req("/login", sent));
    expect(clearedNames(res)).toEqual([COOKIE, `${COOKIE}.4`]);
  });
});
