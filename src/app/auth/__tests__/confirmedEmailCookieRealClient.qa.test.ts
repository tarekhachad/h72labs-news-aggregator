// QA (wave 9, A2): /auth/confirm through the real server client, @supabase/ssr
// and auth-js, with only fetch and the next/headers store faked. In every
// signOut outcome the browser must end up with no session cookie, and with the
// confirmed-email cookie carrying the right address. The cookie then goes
// through Next's real cookie parser into the login page's reader, and the
// sign-in action's delete is checked against Next's real serializer.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestCookies, ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

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

let signOutThrows = false;
vi.mock("@/lib/supabase/server", async () => {
  const real = await vi.importActual<typeof import("@/lib/supabase/server")>("@/lib/supabase/server");
  return {
    createClient: async () => {
      const client = await real.createClient();
      const original = client.auth.signOut.bind(client.auth);
      client.auth.signOut = (async (...args: Parameters<typeof original>) => {
        if (signOutThrows) throw new Error("lock acquisition timed out");
        return original(...args);
      }) as typeof client.auth.signOut;
      return client;
    },
  };
});

const ORIGIN = "https://news.h72labs.com";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SID = "c0f30000-0000-4000-8000-000000000000";
const b64u = (s: string) => Buffer.from(s).toString("base64url");

function verifiedSession(email: string | undefined) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: USER_ID, session_id: SID, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 };
  return {
    access_token: `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${b64u(JSON.stringify(payload))}.sig`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "rt-qa-a2",
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", ...(email === undefined ? {} : { email }) },
  };
}

let userEmail: string | undefined;
let logoutReply: () => Response;
let fetchedUrls: string[];
const json = (s: number, b: unknown) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54393";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      fetchedUrls.push(url.href);
      const path = url.pathname.replace("/auth/v1", "");
      if (path === "/verify") return json(200, verifiedSession(userEmail));
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

let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  jar.clear();
  fetchedUrls = [];
  signOutThrows = false;
  userEmail = "reader+news@example.com";
  logoutReply = () => new Response(null, { status: 204 });
  vi.stubEnv("RECOVERY_MARKER_SECRET", "q".repeat(44));
  errSpy?.mockRestore();
  logSpy?.mockRestore();
  warnSpy?.mockRestore();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

const { GET } = await import("@/app/auth/confirm/route");
const { CONFIRMED_EMAIL_COOKIE, CONFIRMED_EMAIL_PATH, confirmedEmailFromCookie } = await import(
  "@/app/login/confirmedEmail"
);

// What the browser holds afterwards: the store's writes, then the response's own.
function browserHolds(res: Response): Map<string, string> {
  const held = new Map([...jar].map(([k, c]) => [k, c.value]));
  for (const line of res.headers.getSetCookie()) {
    const first = line.split(";")[0];
    const name = first.slice(0, first.indexOf("="));
    if (/max-age=0/i.test(line) || /expires=thu, 01 jan 1970/i.test(line)) held.delete(name);
    else held.set(name, first.slice(name.length + 1));
  }
  return held;
}
const sessionHeld = (res: Response) => [...browserHolds(res).keys()].filter((k) => k.startsWith("sb-"));

// The value the login page would read: the browser echoes name=value as set,
// Next's RequestCookies decodes it, the page's reader shape-checks it.
function loginPageReads(res: Response): string | null {
  const raw = browserHolds(res).get(CONFIRMED_EMAIL_COOKIE);
  if (raw === undefined) return null;
  const parsed = new RequestCookies(new Headers({ cookie: `${CONFIRMED_EMAIL_COOKIE}=${raw}` }));
  return confirmedEmailFromCookie(parsed.get(CONFIRMED_EMAIL_COOKIE)?.value);
}

const confirm = () => GET(new Request(`${ORIGIN}/auth/confirm?token_hash=abc&type=email`));

const outcomes: Array<[string, () => void]> = [
  ["signOut succeeds", () => {}],
  [
    "signOut returns an error (Auth 500)",
    () => {
      logoutReply = () => json(500, { msg: "boom" });
    },
  ],
  [
    "signOut throws",
    () => {
      signOutThrows = true;
    },
  ],
];

describe("every signOut outcome: no session left, confirmed email carried", () => {
  it.each(outcomes)("%s", async (_, arrange) => {
    arrange();
    const res = await confirm();
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?confirmed=1`);
    expect(sessionHeld(res)).toEqual([]);
    expect(loginPageReads(res)).toBe("reader+news@example.com");
    const line = res.headers.getSetCookie().find((l) => l.startsWith(`${CONFIRMED_EMAIL_COOKIE}=`))!.toLowerCase();
    expect(line).toContain("path=/login");
    expect(line).toContain("httponly");
    expect(line).toContain("secure");
    expect(line).toContain("samesite=lax");
    expect(line).toContain("max-age=600");
    // Never in a URL the route built or fetched, never in a log.
    expect(res.headers.get("location")).not.toMatch(/reader|example\.com/);
    for (const u of fetchedUrls) expect(u).not.toMatch(/reader|news%40|news@/);
    for (const spy of [errSpy, logSpy, warnSpy]) expect(JSON.stringify(spy.mock.calls)).not.toContain("example.com");
  });
});

const at254 = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(2)}.com`;
const at255 = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(3)}.com`;

describe("odd addresses from Auth", () => {
  it("lengths are what the cases say", () => {
    expect(at254.length).toBe(254);
    expect(at255.length).toBe(255);
  });

  it.each([
    ["uppercase is lowercased", "Reader@Example.COM", "reader@example.com"],
    ["exactly 254 characters is kept", at254, at254],
    ["255 characters is dropped", at255, null],
    ["no email at all", undefined, null],
    ["markup is dropped", '"><img src=x>@example.com', null],
  ])("%s, and the session still ends", async (_, email, expected) => {
    userEmail = email;
    const res = await confirm();
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?confirmed=1`);
    expect(sessionHeld(res)).toEqual([]);
    expect(loginPageReads(res)).toBe(expected);
  });
});

describe("the sign-in action's delete, through Next's real serializer", () => {
  it("expires the cookie at the path it was set with", () => {
    const headers = new Headers();
    new ResponseCookies(headers).delete({ name: CONFIRMED_EMAIL_COOKIE, path: CONFIRMED_EMAIL_PATH });
    const set = headers.getSetCookie()[0].toLowerCase();
    expect(set.startsWith(`${CONFIRMED_EMAIL_COOKIE}=;`)).toBe(true);
    expect(set).toContain("path=/login");
    expect(set).toContain("expires=thu, 01 jan 1970");
  });
});
