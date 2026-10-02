// /auth/confirm through the real server client, @supabase/ssr and auth-js, with
// only global fetch and the next/headers cookie store faked. Shows what a
// browser is left holding after each kind of emailed link.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Cookie = { value: string; options?: { maxAge?: number } };
const jar = new Map<string, Cookie>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    getAll: () => [...jar].map(([name, c]) => ({ name, value: c.value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Cookie["options"]) => {
      if (value === "" || options?.maxAge === 0) jar.delete(name);
      else jar.set(name, { value, options });
    },
    delete: (name: string) => jar.delete(name),
  })),
}));

const ORIGIN = "https://news.h72labs.com";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SID = "c0f10000-0000-4000-8000-000000000000";
const SECRET = "s".repeat(44);
const b64u = (s: string) => Buffer.from(s).toString("base64url");

function verifiedSession() {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: USER_ID, session_id: SID, role: "authenticated", aud: "authenticated", amr: [{ method: "otp", timestamp: now }], iat: now, exp: now + 3600 };
  return {
    access_token: `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${b64u(JSON.stringify(payload))}.sig`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "rt-confirm",
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "new@example.com" },
  };
}

let session: ReturnType<typeof verifiedSession>;
let verifyStatus: number;
let calls: Array<{ call: string; auth: string | null }>;
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54396";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname.replace("/auth/v1", "");
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ call: `${(init?.method ?? "GET").toUpperCase()} ${path}${url.search}`, auth });
      if (path === "/verify") {
        return verifyStatus === 200 ? json(200, session) : json(verifyStatus, { code: "otp_expired", msg: "Email link is invalid or has expired" });
      }
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
  jar.clear();
  calls = [];
  session = verifiedSession();
  verifyStatus = 200;
  vi.stubEnv("RECOVERY_MARKER_SECRET", SECRET);
});

const { GET } = await import("@/app/auth/confirm/route");
const { RECOVERY_COOKIE } = await import("@/lib/recoveryMarker");

async function confirm(query: string): Promise<string | null> {
  const res = await GET(new Request(`${ORIGIN}/auth/confirm${query}`));
  return res.headers.get("location");
}
const sessionCookies = () => [...jar.keys()].filter((k) => k.startsWith("sb-"));
const logouts = () => calls.filter((c) => c.call.startsWith("POST /logout"));

describe("a signup confirmation link", () => {
  it("leaves no session cookie, revokes the session it made, and sends the user to sign in", async () => {
    const location = await confirm("?token_hash=abc&type=email&next=/onboarding");
    expect(calls[0].call).toBe("POST /verify");
    expect(location).toBe(`${ORIGIN}/login?confirmed=1`);
    expect(sessionCookies()).toEqual([]);
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
    expect(logouts()).toEqual([{ call: "POST /logout?scope=local", auth: `Bearer ${session.access_token}` }]);
  });

  it("that fails to verify creates no session and revokes nothing", async () => {
    verifyStatus = 403;
    expect(await confirm("?token_hash=stale&type=email&next=/onboarding")).toBe(`${ORIGIN}/login?error=link_expired`);
    expect(sessionCookies()).toEqual([]);
    expect(logouts()).toEqual([]);
  });
});

describe("a recovery link is unchanged", () => {
  it("keeps its session and marker and lands on /reset-password", async () => {
    const location = await confirm("?token_hash=abc&type=recovery&next=/reset-password");
    expect(location).toBe(`${ORIGIN}/reset-password`);
    expect(sessionCookies().length).toBeGreaterThan(0);
    expect(jar.has(RECOVERY_COOKIE)).toBe(true);
    expect(logouts()).toEqual([]);
  });
});
