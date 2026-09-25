import { beforeEach, describe, expect, it, vi } from "vitest";

// One file for both halves of the recovery gate, so the marker the confirm
// route actually sets is the one resetPassword is fed.
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
  calls.push(`signOut:${JSON.stringify(a[0])}`);
  return signOutImpl();
});
let signOutImpl: () => unknown = () => ({ error: null });

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { verifyOtp: verifyOtpMock, getClaims: getClaimsMock, updateUser: updateUserMock, signOut: signOutMock },
  })),
}));

// A tiny cookie jar standing in for next/headers: set/get/delete all act on it.
const jar = new Map<string, { value: string; options?: unknown }>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: unknown) => {
      calls.push(`cookie.set:${name}`);
      jar.set(name, { value, options });
    },
    delete: (name: string) => {
      calls.push(`cookie.delete:${name}`);
      jar.delete(name);
    },
  })),
}));

const { GET } = await import("@/app/auth/confirm/route");
const { resetPassword } = await import("@/app/auth/actions");
const { RECOVERY_COOKIE, RECOVERY_COOKIE_OPTIONS, verifyRecoveryMarker, signRecoveryMarker } = await import(
  "@/lib/recoveryMarker"
);

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SECRET = "q".repeat(44);
const ORIGIN = "https://news.h72labs.com";
const now = () => Math.floor(Date.now() / 1000);

async function confirm(query: string) {
  const res = await GET(new Request(`${ORIGIN}/auth/confirm${query}`));
  return res.headers.get("location");
}

function pw(password = "brand-new-pw"): FormData {
  const fd = new FormData();
  fd.set("password", password);
  return fd;
}

async function reset(fd = pw()): Promise<string> {
  try {
    await resetPassword(fd);
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("resetPassword did not redirect");
}

beforeEach(() => {
  jar.clear();
  calls.length = 0;
  verifyOtpMock.mockReset();
  verifyOtpMock.mockResolvedValue({ data: { user: { id: A } }, error: null });
  getClaimsMock.mockReset();
  getClaimsMock.mockResolvedValue({ data: { claims: { sub: A } } });
  updateUserMock.mockClear();
  updateUserImpl = () => ({ data: {}, error: null });
  signOutMock.mockClear();
  signOutImpl = () => ({ error: null });
  vi.stubEnv("RECOVERY_MARKER_SECRET", SECRET);
});

describe("confirm route issues the marker only for a verified recovery", () => {
  it("recovery: sets a marker for the verified user with the declared cookie options", async () => {
    expect(await confirm("?token_hash=h&type=recovery&next=/reset-password")).toBe(`${ORIGIN}/reset-password`);
    const c = jar.get(RECOVERY_COOKIE);
    expect(c).toBeDefined();
    expect(c!.options).toEqual(RECOVERY_COOKIE_OPTIONS);
    expect(verifyRecoveryMarker(c!.value, A, SECRET)).toBe(true);
    expect(verifyRecoveryMarker(c!.value, B, SECRET)).toBe(false);
  });

  it("the marker's user comes from verifyOtp, not from anything in the URL", async () => {
    await confirm(`?token_hash=h&type=recovery&next=/reset-password&user=${B}&sub=${B}`);
    expect(verifyRecoveryMarker(jar.get(RECOVERY_COOKIE)!.value, A, SECRET)).toBe(true);
  });

  it("signup confirmation (type=email) never gets a marker", async () => {
    await confirm("?token_hash=h&type=email&next=/reset-password");
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("a duplicated type param resolves to the first value for both the verify and the marker decision", async () => {
    await confirm("?token_hash=h&type=email&type=recovery&next=/reset-password");
    expect(verifyOtpMock).toHaveBeenCalledWith({ type: "email", token_hash: "h" });
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it.each(["RECOVERY", "recovery ", "magiclink", "invite", "email_change"])(
    "type=%j is refused before verifyOtp and sets nothing",
    async (type) => {
      expect(await confirm(`?token_hash=h&type=${encodeURIComponent(type)}`)).toBe(`${ORIGIN}/login?error=link_expired`);
      expect(verifyOtpMock).not.toHaveBeenCalled();
      expect(jar.has(RECOVERY_COOKIE)).toBe(false);
    }
  );

  it("a failed recovery verification sets nothing", async () => {
    verifyOtpMock.mockResolvedValue({ data: { user: null, session: null }, error: { message: "Token has expired" } });
    expect(await confirm("?token_hash=h&type=recovery&next=/reset-password")).toBe(`${ORIGIN}/login?error=link_expired`);
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("a verified recovery with no user in the response sets nothing", async () => {
    verifyOtpMock.mockResolvedValue({ data: { user: null, session: null }, error: null });
    await confirm("?token_hash=h&type=recovery&next=/reset-password");
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it.each([undefined, "short-secret"])("secret %j: no marker, logged, and the reset action then refuses", async (s) => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", s as string);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await confirm("?token_hash=h&type=recovery&next=/reset-password");
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect(await reset()).toBe("/forgot-password?expired=1");
    expect(updateUserMock).not.toHaveBeenCalled();
  });
});

describe("resetPassword gate", () => {
  it("end to end: a recovery marker from /auth/confirm opens reset exactly once", async () => {
    await confirm("?token_hash=h&type=recovery&next=/reset-password");
    expect(await reset()).toBe("/");
    expect(calls).toEqual([
      `cookie.set:${RECOVERY_COOKIE}`,
      "updateUser",
      `cookie.delete:${RECOVERY_COOKIE}`,
      'signOut:{"scope":"others"}',
    ]);
    expect(updateUserMock).toHaveBeenCalledWith({ password: "brand-new-pw" });
    // Replay: the same browser submitting again is refused and never reaches Auth.
    calls.length = 0;
    expect(await reset()).toBe("/forgot-password?expired=1");
    expect(calls).toEqual([]);
  });

  it("a signup-confirmation session cannot reset", async () => {
    await confirm("?token_hash=h&type=email&next=/");
    expect(await reset()).toBe("/forgot-password?expired=1");
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("cross-account: A's marker with B's session is refused and not spent", async () => {
    await confirm("?token_hash=h&type=recovery&next=/reset-password");
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: B } } });
    expect(await reset()).toBe("/forgot-password?expired=1");
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(jar.has(RECOVERY_COOKIE)).toBe(true);
  });

  it.each([
    ["no session", { data: { claims: null } }],
    ["claims without sub", { data: { claims: { amr: [{ method: "otp", timestamp: now() }] } } }],
    ["empty sub", { data: { claims: { sub: "" } } }],
    ["getClaims error", { data: null, error: { message: "bad jwt" } }],
  ])("%s is refused even with a marker present", async (_l, claims) => {
    jar.set(RECOVERY_COOKIE, { value: signRecoveryMarker("", now(), SECRET) });
    getClaimsMock.mockResolvedValue(claims);
    expect(await reset()).toBe("/forgot-password?expired=1");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("an expired marker (61 minutes old) is refused", async () => {
    jar.set(RECOVERY_COOKIE, { value: signRecoveryMarker(A, now() - 3661, SECRET) });
    expect(await reset()).toBe("/forgot-password?expired=1");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("the old amr-only proof no longer opens reset", async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: A, amr: [{ method: "recovery", timestamp: now() }] } } });
    expect(await reset()).toBe("/forgot-password?expired=1");
  });

  it("weak password: refused before Auth, marker kept so the user can retry", async () => {
    await confirm("?token_hash=h&type=recovery&next=/reset-password");
    expect(await reset(pw("abc"))).toBe("/reset-password?error=weak_password");
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(jar.has(RECOVERY_COOKIE)).toBe(true);
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "same_password", message: "New password should be different from the old password." }, "same_password"],
    [{ code: "weak_password", message: "Password is known to be weak and easy to guess, please choose a different one." }, "reset_failed"],
    [{ code: undefined, message: "relation \"auth.users\" does not exist; host=db.internal" }, "reset_failed"],
  ])("failed update (%j): no marker spend, no eviction, fixed code only", async (error, code) => {
    await confirm("?token_hash=h&type=recovery&next=/reset-password");
    updateUserImpl = () => ({ data: { user: null }, error });
    const url = await reset();
    expect(url).toBe(`/reset-password?error=${code}`);
    expect(url).not.toContain(error.message.slice(0, 10));
    expect(jar.has(RECOVERY_COOKIE)).toBe(true);
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("eviction failure after a successful update still spends the marker, logs, and lands on /", async () => {
    await confirm("?token_hash=h&type=recovery&next=/reset-password");
    signOutImpl = () => ({ error: { message: "session_not_found" } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reset()).toBe("/");
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("marker is spent before eviction runs (a throwing signOut can't leave a reusable marker)", async () => {
    await confirm("?token_hash=h&type=recovery&next=/reset-password");
    signOutImpl = () => {
      throw new Error("network down");
    };
    await expect(resetPassword(pw())).rejects.toThrow("network down");
    expect(jar.has(RECOVERY_COOKIE)).toBe(false);
  });
});
