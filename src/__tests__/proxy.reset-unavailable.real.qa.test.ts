// QA round 1: the signed-in pass-through on /login?error=reset_unavailable,
// through the REAL proxy, @supabase/ssr and auth-js. Only global fetch is
// faked (ES256 tokens verified against a served JWKS, like proxy.auth-lows).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const COOKIE = "sb-127-auth-token";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const SID = "b0b00000-0000-4000-8000-000000000000";
const KID = "qa-reset-unavailable";
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };

function accessToken(expiresIn: number): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: KID }));
  const p = b64u(JSON.stringify({ sub: "u-ru", session_id: SID, role: "authenticated", aud: "authenticated", iat: now - 10, exp: now + expiresIn }));
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64u(sig)}`;
}
function session(expiresIn: number, rt = "rt-ru") {
  const now = Math.floor(Date.now() / 1000);
  return { access_token: accessToken(expiresIn), token_type: "bearer", expires_in: expiresIn, expires_at: now + expiresIn, refresh_token: rt, user: { id: "u-ru" } };
}
const cookie = (expiresIn = 3600) => `${COOKIE}=base64-${b64u(JSON.stringify(session(expiresIn)))}; theme=dark; sb-otherref-auth-token=theirs`;

const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
let userReply: () => Promise<Response>;
let tokenReply: () => Promise<Response>;
let calls: Array<{ call: string; signal: AbortSignal | null | undefined }>;

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
      if (path === "/.well-known/jwks.json") return json(200, { keys: [jwk] });
      if (path === "/token") return tokenReply();
      if (path === "/user") return userReply();
      if (path === "/logout") return new Response(null, { status: 204 });
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
  userReply = async () => json(200, { id: "u-ru", aud: "authenticated", role: "authenticated" });
  tokenReply = async () => json(200, session(3600, "rt-rotated"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const { proxy } = await import("@/proxy");
const req = (path: string, c = cookie(), method = "GET") =>
  new NextRequest(new Request(`https://news.h72labs.com${path}`, { method, headers: { cookie: c } }));
const lines = (res: Response) => res.headers.getSetCookie();
const expiring = (l: string) => /max-age=0/i.test(l) || /expires=thu, 01 jan 1970/i.test(l);
const RU = "/login?error=reset_unavailable";

describe("signed in on /login?error=reset_unavailable, real auth-js", () => {
  it("renders (no redirect), Auth is asked once under the deadline, nothing is revoked or cleared", async () => {
    const res = await proxy(req(RU));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(calls.filter((c) => c.call.startsWith("GET /user")).map((c) => !!c.signal)).toEqual([true]);
    expect(calls.some((c) => c.call.startsWith("POST /logout"))).toBe(false);
    expect(lines(res).filter(expiring)).toEqual([]);
  });

  it("a session that needed refreshing: the refreshed cookie reaches the browser on the pass-through", async () => {
    const res = await proxy(req(RU, cookie(5)));
    expect(res.headers.get("location")).toBeNull();
    const refresh = calls.filter((c) => c.call.startsWith("POST /token"));
    expect(refresh).toHaveLength(1);
    expect(refresh[0].signal).toBeUndefined();
    const ours = lines(res).filter((l) => l.startsWith(`${COOKIE}=`));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.some((l) => !expiring(l) && l.length > `${COOKIE}=`.length + 10)).toBe(true);
  });

  it("Auth down (500): renders, the live session's cookies are kept", async () => {
    userReply = async () => json(500, { msg: "boom" });
    const res = await proxy(req(RU));
    expect(res.headers.get("location")).toBeNull();
    expect(calls.some((c) => c.call.startsWith("POST /logout"))).toBe(false);
    expect(lines(res).filter(expiring)).toEqual([]);
  });

  it("Auth rejects the token (403): revoked with scope=local, only this project's cookie expired, renders", async () => {
    userReply = async () => json(403, { code: 403, error_code: "user_not_found", msg: "gone" });
    const res = await proxy(req(RU));
    expect(res.headers.get("location")).toBeNull();
    expect(calls.filter((c) => c.call.startsWith("POST /logout")).map((c) => c.call)).toEqual(["POST /logout?scope=local"]);
    const expired = lines(res).filter(expiring).map((l) => l.slice(0, l.indexOf("=")));
    expect(expired).toEqual([COOKIE]);
  });

  it.each(["HEAD", "POST"])("a %s to the same URL behaves like the GET (no special-casing by method)", async (method) => {
    const res = await proxy(req(RU, cookie(), method));
    expect(res.headers.get("location")).toBeNull();
  });

  it.each([
    "/login?error=reset%5Funavailable",
    "/login?error=reset_unavailable#x",
    "/login?confirmed=1&error=reset_unavailable",
  ])("encoded or reordered variants the page itself reads as reset_unavailable also render: %s", async (path) => {
    const res = await proxy(req(path));
    expect(res.headers.get("location")).toBeNull();
  });

  it.each([
    "/login/?error=reset_unavailable",
    "/LOGIN?error=reset_unavailable",
    "/login?error=reset_unavailable%00",
    "/login?error=%20reset_unavailable",
    "/login?error[]=reset_unavailable",
    "/signup?error=reset_unavailable",
  ])("near-misses are not the exception: %s", async (path) => {
    const res = await proxy(req(path));
    const loc = res.headers.get("location");
    // /login/ and /LOGIN are not /login, so the /login check does not run at all;
    // the rest are /login or /signup and must still bounce to /.
    if (loc === null) {
      expect(new URL(`https://x${path}`).pathname).not.toMatch(/^\/(login|signup)$/);
    } else {
      expect(new URL(loc).pathname).toBe("/");
      expect(new URL(loc).origin).toBe("https://news.h72labs.com");
    }
  });

  it("a signed-out visitor to the same URL just renders, with no Auth user check", async () => {
    const res = await proxy(req(RU, "theme=dark"));
    expect(res.headers.get("location")).toBeNull();
    expect(calls.some((c) => c.call.startsWith("GET /user"))).toBe(false);
  });
});
