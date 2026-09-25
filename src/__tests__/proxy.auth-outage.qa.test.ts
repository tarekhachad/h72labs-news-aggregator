// QA finding test: a transient Auth failure on GET /user (5xx) is not proof the
// session is dead. These assert that a LIVE session survives an Auth blip on
// /login. They fail at 33f1cd2, which signs the session out on any getUser miss.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const COOKIE = "sb-127-auth-token";
const KID = "qa-es256-outage";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const LIVE = "11ve0000-0000-4000-8000-000000000000";

function cookie(): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: KID }));
  const p = b64u(JSON.stringify({ sub: "u1", session_id: LIVE, role: "authenticated", aud: "authenticated", iat: now - 10, exp: now + 3600 }));
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  const session = { access_token: `${h}.${p}.${b64u(sig)}`, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: "rt", user: { id: "u1" } };
  return `${COOKIE}=base64-${b64u(JSON.stringify(session))}`;
}

let serverSessions: Set<string>;
let logoutStatus: number;
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54399";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
      if (url.pathname.endsWith("/.well-known/jwks.json")) return json(200, { keys: [JWK] });
      if (url.pathname.endsWith("/user")) return json(503, { code: 503, msg: "upstream unavailable" });
      if (url.pathname.endsWith("/logout")) {
        if (logoutStatus === 204) serverSessions.delete(LIVE);
        return logoutStatus === 204 ? new Response(null, { status: 204 }) : json(logoutStatus, { msg: "down" });
      }
      void init;
      return json(404, {});
    })
  );
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  serverSessions = new Set([LIVE]);
  logoutStatus = 204;
});

const { proxy } = await import("@/proxy");
const req = (path: string) => new NextRequest(new Request(`https://news.h72labs.com${path}`, { headers: { cookie: cookie() } }));

describe("Auth answers 503 on GET /user while the session is actually live", () => {
  it("does not loop: /login renders", async () => {
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not revoke the live session server-side", async () => {
    await proxy(req("/login"));
    expect(serverSessions.has(LIVE)).toBe(true);
  });

  it("does not clear the live session's cookies", async () => {
    logoutStatus = 503;
    const res = await proxy(req("/login"));
    const cleared = res.headers.getSetCookie().filter((l) => l.startsWith("sb-") && /max-age=0/i.test(l));
    expect(cleared).toEqual([]);
  });
});
