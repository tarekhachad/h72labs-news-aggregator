// QA: revoking a token Auth rejected on /login must not start a refresh under
// the deadline, whose retry loop would outlast the bound.
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
  process.env.SUPABASE_URL = "http://127.0.0.1:54394";
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

describe("a token Auth rejects slowly, near its expiry", () => {
  // The token is 92s from expiry when getSession reads it (no refresh), and has
  // crossed auth-js's 90s refresh margin by the time Auth's slow rejection
  // arrives. Revoking it must not reload the session, which would refresh it
  // under the deadline and let auth-js's retry loop outlast the bound.
  it(
    "is revoked without any refresh, and /login answers within the deadline with the cookies cleared",
    async () => {
      userReply = after(4000, () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" }));
      tokenReply = hang;
      const sent = cookie(92);
      const { res, elapsed } = await timed("/login", sent);
      expect(callsTo("POST /token")).toEqual([]);
      expect(location(res)).toBeNull();
      expect(cleared(res).length).toBeGreaterThan(0);
      expect(jarSession(sent, res)).toBeNull();
      expect(elapsed).toBeLessThan(DEADLINE_MS + 800);
    },
    45000
  );

  it(
    "and /logout then hangs: still within the deadline, cookies cleared",
    async () => {
      userReply = after(4000, () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" }));
      logoutReply = hang;
      const sent = cookie(92);
      const { res, elapsed } = await timed("/login", sent);
      expect(logouts()).toHaveLength(1);
      expect(callsTo("POST /token")).toEqual([]);
      expect(jarSession(sent, res)).toBeNull();
      expect(elapsed).toBeLessThan(DEADLINE_MS + 800);
    },
    45000
  );
});
