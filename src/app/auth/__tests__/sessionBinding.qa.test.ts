import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
}));

const calls: string[] = [];
const verifyOtpMock = vi.fn();
const getClaimsMock = vi.fn();
const updateUserMock = vi.fn(async (...a: unknown[]) => {
  calls.push("updateUser");
  return updateUserImpl(...a);
});
let updateUserImpl: (...a: unknown[]) => unknown = () => ({ data: {}, error: null });
const signOutMock = vi.fn(async (...a: unknown[]) => {
  calls.push(`signOut:${JSON.stringify(a[0] ?? null)}`);
  return signOutImpl();
});
let signOutImpl: () => unknown = () => ({ error: null });

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { verifyOtp: verifyOtpMock, getClaims: getClaimsMock, updateUser: updateUserMock, signOut: signOutMock },
  })),
}));

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      calls.push(`cookie.set:${name}`);
      jar.set(name, value);
    },
    delete: (name: string) => {
      calls.push(`cookie.delete:${name}`);
      jar.delete(name);
    },
  })),
}));

const { GET } = await import("@/app/auth/confirm/route");
const { resetPassword, signOutAction } = await import("@/app/auth/actions");
const { default: ResetPasswordPage } = await import("@/app/reset-password/page");
const { RECOVERY_COOKIE, markerSubject, verifyRecoveryMarker } = await import("@/lib/recoveryMarker");

const A = "11111111-1111-4111-8111-111111111111";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = "z".repeat(44);
const ORIGIN = "https://news.h72labs.com";

const tokenWith = (payload: unknown) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

async function confirm(query = "?token_hash=h&type=recovery&next=/reset-password") {
  const res = await GET(new Request(`${ORIGIN}/auth/confirm${query}`));
  return res.headers.get("location") ?? "";
}

async function redirectOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("did not redirect");
}

const pw = () => {
  const fd = new FormData();
  fd.set("password", "brand-new-pw");
  return fd;
};
const reset = () => redirectOf(() => resetPassword(pw()));
const page = () => redirectOf(() => ResetPasswordPage({ searchParams: Promise.resolve({}) })).catch(() => "RENDERED");
// The page renders JSX when the gate opens; redirectOf throws "did not redirect" then.
async function pageOpens(): Promise<boolean> {
  try {
    await ResetPasswordPage({ searchParams: Promise.resolve({}) });
    return true;
  } catch (e) {
    if (e instanceof RedirectSignal) return false;
    throw e;
  }
}

const claimsFor = (sub: string, session_id?: unknown) => ({
  data: { claims: session_id === undefined ? { sub } : { sub, session_id } },
});

beforeEach(() => {
  jar.clear();
  calls.length = 0;
  verifyOtpMock.mockReset();
  verifyOtpMock.mockResolvedValue({ data: { user: { id: A }, session: { access_token: tokenWith({ sub: A, session_id: S1 }) } }, error: null });
  getClaimsMock.mockReset();
  getClaimsMock.mockResolvedValue(claimsFor(A, S1));
  updateUserMock.mockClear();
  updateUserImpl = () => ({ data: {}, error: null });
  signOutMock.mockClear();
  signOutImpl = () => ({ error: null });
  vi.stubEnv("RECOVERY_MARKER_SECRET", SECRET);
});

describe("session binding end to end", () => {
  it("the minting session opens both the page and the action", async () => {
    await confirm();
    expect(await pageOpens()).toBe(true);
    expect(await reset()).toBe("/");
    expect(updateUserMock).toHaveBeenCalledTimes(1);
  });

  it("an old session's marker does not open a later session of the same user (page or action)", async () => {
    await confirm();
    getClaimsMock.mockResolvedValue(claimsFor(A, S2));
    expect(await pageOpens()).toBe(false);
    expect(await reset()).toBe("/forgot-password?expired=1");
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing session_id", undefined],
    ["empty session_id", ""],
    ["null session_id", null],
    ["numeric session_id", 1],
  ])("claims with %s are refused even with a valid marker for the user", async (_l, sid) => {
    await confirm();
    getClaimsMock.mockResolvedValue(claimsFor(A, sid));
    expect(await pageOpens()).toBe(false);
    expect(await reset()).toBe("/forgot-password?expired=1");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("the session id comes from the verifyOtp token, not from the URL", async () => {
    await confirm(`?token_hash=h&type=recovery&next=/reset-password&session_id=${S2}`);
    const v = jar.get(RECOVERY_COOKIE)!;
    expect(verifyRecoveryMarker(v, markerSubject(A, S1), SECRET)).toBe(true);
    expect(verifyRecoveryMarker(v, markerSubject(A, S2), SECRET)).toBe(false);
  });

  it.each([
    ["no access_token", { user: { id: A }, session: {} }],
    ["no session", { user: { id: A } }],
    ["token without session_id", { user: { id: A }, session: { access_token: tokenWith({ sub: A }) } }],
    ["token with empty session_id", { user: { id: A }, session: { access_token: tokenWith({ session_id: "" }) } }],
    ["token with numeric session_id", { user: { id: A }, session: { access_token: tokenWith({ session_id: 7 }) } }],
    ["non-JWT access_token", { user: { id: A }, session: { access_token: "opaque" } }],
    ["no user", { user: null, session: { access_token: tokenWith({ session_id: S1 }) } }],
  ])("%s: no marker, lands on next, and the reset stays closed", async (_l, data) => {
    verifyOtpMock.mockResolvedValue({ data, error: null });
    expect(await confirm()).toBe(`${ORIGIN}/reset-password`);
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
    expect(await reset()).toBe("/forgot-password?expired=1");
  });

  it("a crafted token whose session_id contains '.' mints a marker that never verifies", async () => {
    verifyOtpMock.mockResolvedValue({
      data: { user: { id: A }, session: { access_token: tokenWith({ session_id: "x.y" }) } },
      error: null,
    });
    await confirm();
    getClaimsMock.mockResolvedValue(claimsFor(A, "x.y"));
    expect(await reset()).toBe("/forgot-password?expired=1");
  });
});

describe("signOutAction clears the marker", () => {
  it("signs out, then deletes the marker, then redirects to /login", async () => {
    await confirm();
    calls.length = 0;
    expect(await redirectOf(() => signOutAction())).toBe("/login");
    expect(calls).toEqual(["signOut:null", `cookie.delete:${RECOVERY_COOKIE}`]);
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("a marker kept across sign-out and a fresh sign-in (new session) still refuses", async () => {
    await confirm();
    const kept = jar.get(RECOVERY_COOKIE)!;
    await redirectOf(() => signOutAction());
    jar.set(RECOVERY_COOKIE, kept); // copied back by hand
    getClaimsMock.mockResolvedValue(claimsFor(A, S2));
    expect(await reset()).toBe("/forgot-password?expired=1");
  });
});

describe("eviction failure after a successful reset", () => {
  it("a throwing signOut({scope:'others'}) is logged and still lands on /", async () => {
    await confirm();
    signOutImpl = () => {
      throw new Error("network down");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reset()).toBe("/");
    expect(updateUserMock).toHaveBeenCalledTimes(1);
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("threw"), expect.any(Error));
    err.mockRestore();
  });

  it("a rejected signOut promise is also caught", async () => {
    await confirm();
    signOutImpl = () => Promise.reject(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reset()).toBe("/");
    err.mockRestore();
  });

  it("an error-returning signOut is logged and still lands on /", async () => {
    await confirm();
    signOutImpl = () => ({ error: { message: "session_not_found" } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reset()).toBe("/");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("failed"), { message: "session_not_found" });
    err.mockRestore();
  });

  it("after a throwing eviction the marker is spent: a replay is refused", async () => {
    await confirm();
    signOutImpl = () => {
      throw new Error("x");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reset();
    expect(await reset()).toBe("/forgot-password?expired=1");
    expect(updateUserMock).toHaveBeenCalledTimes(1);
  });
});

describe("missing or short secret on a verified recovery link", () => {
  it.each([undefined, "", "short", "x".repeat(31)])("secret %j → /login?error=reset_unavailable, no marker", async (s) => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", s as string);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const loc = await confirm();
    expect(loc).toBe(`${ORIGIN}/login?error=reset_unavailable`);
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
    err.mockRestore();
  });

  it("a 32-char secret is enough (boundary) and mints a marker", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "x".repeat(32));
    expect(await confirm()).toBe(`${ORIGIN}/reset-password`);
    expect(jar.has(RECOVERY_COOKIE)).toBe(true);
  });

  it("a signup link with no secret is unaffected", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "");
    expect(await confirm("?token_hash=h&type=email&next=/onboarding")).toBe(`${ORIGIN}/onboarding`);
  });

  it("with no secret, a recovery link is refused before verifying, whatever its state", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "");
    verifyOtpMock.mockResolvedValue({ data: { user: null, session: null }, error: { code: "otp_expired", message: "Email link is invalid or has expired" } });
    expect(await confirm()).toBe(`${ORIGIN}/login?error=reset_unavailable`);
    expect(verifyOtpMock).not.toHaveBeenCalled();
  });
});

describe("nothing from Auth reaches a URL", () => {
  const AUTH_TEXT = "Secret-Auth-Text <script>";
  it("verifyOtp error text is never in the redirect", async () => {
    verifyOtpMock.mockResolvedValue({ data: {}, error: { code: AUTH_TEXT, message: AUTH_TEXT } });
    const loc = await confirm();
    expect(loc).toBe(`${ORIGIN}/login?error=link_expired`);
  });

  it("session id and user id from Auth never appear in the redirect", async () => {
    const loc = await confirm();
    expect(loc).not.toContain(S1);
    expect(loc).not.toContain(A);
  });

  it("updateUser error text is never in the redirect", async () => {
    await confirm();
    updateUserImpl = () => ({ data: {}, error: { code: AUTH_TEXT, message: AUTH_TEXT } });
    expect(await reset()).toBe("/reset-password?error=reset_failed");
  });

  it("eviction error text is never in the redirect", async () => {
    await confirm();
    signOutImpl = () => {
      throw new Error(AUTH_TEXT);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reset()).toBe("/");
  });

  it("page helper sanity", async () => {
    expect(await page()).toBe("/forgot-password?expired=1");
  });
});
