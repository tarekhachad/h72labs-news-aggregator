// QA: /auth/confirm through the real server client,
// @supabase/ssr and auth-js, with only global fetch and the next/headers cookie
// store faked. Odd query strings, /logout failures, chunked cookies, and what a
// browser is left holding in each case.
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

// Lets one test make signOut itself throw, with everything else real.
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
const USER_ID = "22222222-2222-4222-8222-222222222222";
const SID = "c0f20000-0000-4000-8000-000000000000";
const SECRET = "q".repeat(44);
const b64u = (s: string) => Buffer.from(s).toString("base64url");

function verifiedSession(extraUser: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: USER_ID, session_id: SID, role: "authenticated", aud: "authenticated", amr: [{ method: "otp", timestamp: now }], iat: now, exp: now + 3600 };
  return {
    access_token: `${b64u(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${b64u(JSON.stringify(payload))}.sig`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "rt-confirm-qa",
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "new@example.com", ...extraUser },
  };
}

let session: ReturnType<typeof verifiedSession>;
let verifyReply: () => Response | Promise<Response>;
let logoutReply: () => Response | Promise<Response>;
let calls: Array<{ call: string; auth: string | null; body?: string }>;
const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
beforeAll(() => {
  process.env.SUPABASE_URL = "http://127.0.0.1:54392";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_dummy";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname.replace("/auth/v1", "");
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ call: `${(init?.method ?? "GET").toUpperCase()} ${path}${url.search}`, auth, body: typeof init?.body === "string" ? init.body : undefined });
      if (path === "/verify") return verifyReply();
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
beforeEach(() => {
  jar.clear();
  calls = [];
  signOutThrows = false;
  session = verifiedSession();
  verifyReply = () => json(200, session);
  logoutReply = () => new Response(null, { status: 204 });
  vi.stubEnv("RECOVERY_MARKER_SECRET", SECRET);
  errSpy?.mockRestore();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

const { GET } = await import("@/app/auth/confirm/route");
const { RECOVERY_COOKIE } = await import("@/lib/recoveryMarker");

async function confirm(query: string): Promise<string | null> {
  const res = await GET(new Request(`${ORIGIN}/auth/confirm${query}`));
  return res.headers.get("location");
}
const sessionCookies = () => [...jar.keys()].filter((k) => k.startsWith("sb-"));
const expiredOn = (res: Response) =>
  res.headers.getSetCookie().filter((l) => /max-age=0/i.test(l)).map((l) => l.slice(0, l.indexOf("="))).sort();
// What the browser holds afterwards: Next applies the cookie store's writes,
// then the returned response's own cookies, which take precedence.
function browserSessionCookies(res: Response): string[] {
  const held = new Set(jar.keys());
  for (const line of res.headers.getSetCookie()) {
    const name = line.slice(0, line.indexOf("="));
    if (/max-age=0/i.test(line)) held.delete(name);
    else held.add(name);
  }
  return [...held].filter((k) => k.startsWith("sb-")).sort();
}
const logouts = () => calls.filter((c) => c.call.startsWith("POST /logout"));
const verifies = () => calls.filter((c) => c.call.startsWith("POST /verify"));
const CONFIRMED = `${ORIGIN}/login?confirmed=1`;
const EXPIRED = `${ORIGIN}/login?error=link_expired`;

describe("type=email always ends at /login?confirmed=1, whatever next says", () => {
  it.each(["", "&next=/", "&next=/profile", "&next=/reset-password", "&next=//evil.example", "&next=https://evil.example", "&next=%2F%2Fevil.example", "&next=/onboarding&next=//evil.example"])(
    "next variant %j",
    async (nextPart) => {
      expect(await confirm(`?token_hash=abc&type=email${nextPart}`)).toBe(CONFIRMED);
      expect(sessionCookies()).toEqual([]);
      expect(logouts()).toHaveLength(1);
    }
  );

  it("sends exactly one /verify with type=email and the token hash, then one scope=local /logout with the new session's token", async () => {
    await confirm("?token_hash=th-123&type=email");
    expect(verifies()).toHaveLength(1);
    expect(JSON.parse(verifies()[0].body!)).toMatchObject({ type: "email", token_hash: "th-123" });
    expect(logouts()).toEqual([{ call: "POST /logout?scope=local", auth: `Bearer ${session.access_token}`, body: undefined }]);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("never sets the recovery marker, even with the secret configured", async () => {
    await confirm("?token_hash=abc&type=email&next=/reset-password");
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("a large (chunked) session cookie has every chunk removed", async () => {
    session = verifiedSession({ user_metadata: { blob: "x".repeat(9000) } });
    let maxChunks = 0;
    const realSet = jar.set.bind(jar);
    jar.set = ((k: string, v: Cookie) => {
      if (/^sb-.*\.\d+$/.test(k)) maxChunks = Math.max(maxChunks, Number(k.split(".").pop()) + 1);
      return realSet(k, v);
    }) as typeof jar.set;
    try {
      expect(await confirm("?token_hash=abc&type=email")).toBe(CONFIRMED);
    } finally {
      jar.set = realSet;
    }
    expect(maxChunks).toBeGreaterThan(1); // the session really was chunked
    expect(sessionCookies()).toEqual([]);
  });

  it("a browser already signed in as someone else ends with no session at all (the old one is overwritten, then removed)", async () => {
    jar.set("sb-127-auth-token", { value: "base64-" + b64u(JSON.stringify(verifiedSession({ id: "someone-else" }))) });
    expect(await confirm("?token_hash=abc&type=email")).toBe(CONFIRMED);
    expect(sessionCookies()).toEqual([]);
    expect(logouts()[0].auth).toBe(`Bearer ${session.access_token}`);
  });
});

describe("/logout failing does not change where the user goes, and still clears the browser", () => {
  const failures: Array<[string, () => Response | Promise<Response>, boolean]> = [
    ["500", () => json(500, { msg: "boom" }), true],
    ["503 HTML", () => new Response("<html>down</html>", { status: 503 }), true],
    ["429", () => json(429, { code: 429, error_code: "over_request_rate_limit", msg: "slow" }), true],
    ["network error", () => { throw new TypeError("fetch failed"); }, true],
    ["401 (auth-js treats as already signed out)", () => json(401, { code: 401, error_code: "bad_jwt", msg: "x" }), false],
    ["403 session_not_found", () => json(403, { code: 403, error_code: "session_not_found", msg: "x" }), false],
    ["404", () => json(404, { code: 404, error_code: "user_not_found", msg: "x" }), false],
  ];
  it.each(failures)("/logout %s", async (_l, reply, logged) => {
    logoutReply = reply;
    expect(await confirm("?token_hash=abc&type=email&next=/profile")).toBe(CONFIRMED);
    expect(sessionCookies()).toEqual([]);
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
    if (logged) expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[auth/confirm]"), expect.anything());
    else expect(errSpy).not.toHaveBeenCalled();
  });

  it("signOut throwing outright still redirects to /login?confirmed=1 and is logged", async () => {
    signOutThrows = true;
    expect(await confirm("?token_hash=abc&type=email")).toBe(CONFIRMED);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("threw"), expect.any(Error));
  });

  // The route promises the confirmation session is ended. When signOut throws
  // before it removes anything, the cookies verifyOtp just wrote are still in
  // the cookie store, so the route expires them on the redirect itself.
  it("signOut throwing outright still leaves the browser with no session cookie", async () => {
    signOutThrows = true;
    const res = await GET(new Request(`${ORIGIN}/auth/confirm?token_hash=abc&type=email`));
    expect(res.headers.get("location")).toBe(CONFIRMED);
    expect(jar.has("sb-127-auth-token")).toBe(true); // the store alone would have kept it
    expect(browserSessionCookies(res)).toEqual([]);
  });

  it("signOut throwing outright on a chunked session expires every chunk", async () => {
    signOutThrows = true;
    session = verifiedSession({ user_metadata: { blob: "x".repeat(9000) } });
    const res = await GET(new Request(`${ORIGIN}/auth/confirm?token_hash=abc&type=email`));
    expect(sessionCookies().filter((k) => /\.\d+$/.test(k)).length).toBeGreaterThan(1);
    expect(browserSessionCookies(res)).toEqual([]);
  });

  it("signOut throwing outright expires only this project's cookies, not another project's", async () => {
    signOutThrows = true;
    jar.set("sb-otherref-auth-token", { value: "theirs" });
    jar.set("sb-otherref-auth-token.0", { value: "theirs" });
    const res = await GET(new Request(`${ORIGIN}/auth/confirm?token_hash=abc&type=email`));
    expect(expiredOn(res)).toEqual(["sb-127-auth-token"]);
    expect(browserSessionCookies(res)).toEqual(["sb-otherref-auth-token", "sb-otherref-auth-token.0"]);
  });

  it("signOut throwing and the cookie store then failing too still redirects to /login?confirmed=1, and logs both", async () => {
    signOutThrows = true;
    const { cookies } = await import("next/headers");
    const store = vi.mocked(cookies).getMockImplementation()!;
    // The first read is createClient's; the second is the route's own, after the throw.
    vi.mocked(cookies)
      .mockImplementationOnce(store)
      .mockImplementationOnce(async () => {
        throw new Error("store gone");
      });
    expect(await confirm("?token_hash=abc&type=email")).toBe(CONFIRMED);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("ending the confirmation session threw"), expect.any(Error));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("expiring the confirmation session's cookies threw"), expect.any(Error));
  });

  // The only cookie on the redirect is the login form's confirmed email.
  it("a signOut that returns its failure sets no session cookie on the redirect (the store already cleared them)", async () => {
    logoutReply = () => json(500, { msg: "boom" });
    const res = await GET(new Request(`${ORIGIN}/auth/confirm?token_hash=abc&type=email`));
    expect(res.headers.getSetCookie().map((c) => c.split("=")[0])).toEqual(["pna_confirmed_email"]);
    expect(browserSessionCookies(res)).toEqual([]);
  });
});

describe("type parameter edge cases", () => {
  it("duplicated type: the first one wins (email then recovery -> confirmation path)", async () => {
    expect(await confirm("?token_hash=abc&type=email&type=recovery&next=/reset-password")).toBe(CONFIRMED);
    expect(JSON.parse(verifies()[0].body!).type).toBe("email");
    expect(sessionCookies()).toEqual([]);
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("duplicated type: recovery then email -> recovery path, session and marker kept", async () => {
    expect(await confirm("?token_hash=abc&type=recovery&type=email&next=/reset-password")).toBe(`${ORIGIN}/reset-password`);
    expect(JSON.parse(verifies()[0].body!).type).toBe("recovery");
    expect(sessionCookies().length).toBeGreaterThan(0);
    expect(jar.has(RECOVERY_COOKIE)).toBe(true);
    expect(logouts()).toEqual([]);
  });

  it.each(["EMAIL", "Email", "email%20", "%20email", "signup", "magiclink", "invite", "email_change", "recovery%00", ""])(
    "type=%j is refused before any Auth call",
    async (t) => {
      expect(await confirm(`?token_hash=abc&type=${t}`)).toBe(EXPIRED);
      expect(calls).toEqual([]);
      expect(sessionCookies()).toEqual([]);
    }
  );

  it("missing token_hash is refused before any Auth call", async () => {
    expect(await confirm("?type=email")).toBe(EXPIRED);
    expect(calls).toEqual([]);
  });

  it("empty token_hash is refused before any Auth call", async () => {
    expect(await confirm("?token_hash=&type=email")).toBe(EXPIRED);
    expect(calls).toEqual([]);
  });
});

describe("verification failing", () => {
  it.each([
    ["403 otp_expired", () => json(403, { code: 403, error_code: "otp_expired", msg: "expired" })],
    ["400", () => json(400, { msg: "bad" })],
    ["500", () => json(500, { msg: "boom" })],
    ["network", () => { throw new TypeError("fetch failed"); }],
  ] as Array<[string, () => Response]>)("%s on /verify: link_expired, no session, no /logout", async (_l, reply) => {
    verifyReply = reply;
    expect(await confirm("?token_hash=abc&type=email&next=/profile")).toBe(EXPIRED);
    expect(sessionCookies()).toEqual([]);
    expect(logouts()).toEqual([]);
  });
});

describe("recovery stays as it was", () => {
  it("follows a safe next and keeps session + marker, no /logout", async () => {
    expect(await confirm("?token_hash=abc&type=recovery&next=/reset-password")).toBe(`${ORIGIN}/reset-password`);
    expect(sessionCookies().length).toBeGreaterThan(0);
    expect(jar.has(RECOVERY_COOKIE)).toBe(true);
    expect(logouts()).toEqual([]);
  });

  it("an unsafe next falls back to /", async () => {
    expect(await confirm("?token_hash=abc&type=recovery&next=//evil.example")).toBe(`${ORIGIN}/`);
    expect(sessionCookies().length).toBeGreaterThan(0);
  });
});
