import { beforeEach, describe, expect, it, vi } from "vitest";

// /auth/confirm hands the confirmed address to the login form in a cookie,
// never in the URL, and still ends the session the link made.

const verifyOtpMock = vi.fn();
const signOutMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { verifyOtp: verifyOtpMock, signOut: signOutMock } })),
}));

const cookieSetMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: cookieSetMock, getAll: () => [] })),
}));

const { GET } = await import("@/app/auth/confirm/route");
const { CONFIRMED_EMAIL_COOKIE } = await import("@/app/login/confirmedEmail");

const ORIGIN = "https://news.h72labs.com";
const EMAIL = "reader+news@example.com";
const SID = "99999999-9999-4999-8999-999999999999";
const token = `h.${Buffer.from(JSON.stringify({ session_id: SID })).toString("base64url")}.s`;

function verified(email: unknown) {
  return { data: { user: { id: "11111111-1111-4111-8111-111111111111", email }, session: { access_token: token } }, error: null };
}

async function confirm(query: string) {
  return GET(new Request(`${ORIGIN}/auth/confirm${query}`));
}

function cookieHeader(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

beforeEach(() => {
  verifyOtpMock.mockReset();
  verifyOtpMock.mockResolvedValue(verified(EMAIL));
  signOutMock.mockReset();
  signOutMock.mockResolvedValue({ error: null });
  cookieSetMock.mockReset();
  vi.stubEnv("RECOVERY_MARKER_SECRET", "s".repeat(44));
});

describe("the confirmed-email cookie", () => {
  it("is set on the redirect to login, with the email nowhere in the URL", async () => {
    const res = await confirm("?token_hash=abc&type=email");
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`${ORIGIN}/login?confirmed=1`);
    expect(location).not.toContain("example.com");
    expect(location).not.toContain(encodeURIComponent(EMAIL));
    expect(cookieHeader(res, CONFIRMED_EMAIL_COOKIE)).toBeDefined();
  });

  it("is HttpOnly, Secure, SameSite=Lax, scoped to /login, and lives ten minutes", async () => {
    const header = cookieHeader(await confirm("?token_hash=abc&type=email"), CONFIRMED_EMAIL_COOKIE)!;
    const attrs = header.split(";").map((p) => p.trim().toLowerCase());
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("secure");
    expect(attrs).toContain("samesite=lax");
    expect(attrs).toContain("path=/login");
    expect(attrs).toContain("max-age=600");
    expect(attrs.some((a) => a.startsWith("domain="))).toBe(false);
  });

  it("carries the address encoded, so a + or @ survives the round trip", async () => {
    const header = cookieHeader(await confirm("?token_hash=abc&type=email"), CONFIRMED_EMAIL_COOKIE)!;
    const raw = header.split(";")[0].slice(CONFIRMED_EMAIL_COOKIE.length + 1);
    expect(decodeURIComponent(raw)).toBe(EMAIL);
  });

  it("is still set, and the session still ended, when ending the session throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    signOutMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await confirm("?token_hash=abc&type=email");
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?confirmed=1`);
    expect(cookieHeader(res, CONFIRMED_EMAIL_COOKIE)).toBeDefined();
    logged.mockRestore();
  });

  it("never reaches a log, even on the failure paths", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    signOutMock.mockResolvedValue({ error: { message: "Service Unavailable", status: 503 } });
    await confirm("?token_hash=abc&type=email");
    signOutMock.mockRejectedValue(new TypeError("fetch failed"));
    await confirm("?token_hash=abc&type=email");
    for (const spy of [logged, warned, info]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("example.com");
      spy.mockRestore();
    }
  });

  it.each([
    ["no email on the user", undefined],
    ["an empty email", ""],
    ["something that isn't an address", "<script>x</script>"],
  ])("is not set for %s, and the reader still lands on login", async (_, email) => {
    verifyOtpMock.mockResolvedValue(verified(email));
    const res = await confirm("?token_hash=abc&type=email");
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?confirmed=1`);
    expect(cookieHeader(res, CONFIRMED_EMAIL_COOKIE)).toBeUndefined();
    expect(signOutMock).toHaveBeenCalledWith({ scope: "local" });
  });

  it("is not set for a recovery link", async () => {
    const res = await confirm("?token_hash=abc&type=recovery&next=/reset-password");
    expect(cookieHeader(res, CONFIRMED_EMAIL_COOKIE)).toBeUndefined();
    expect(cookieSetMock.mock.calls.map((c) => c[0])).not.toContain(CONFIRMED_EMAIL_COOKIE);
  });

  it("is not set when the link fails to verify", async () => {
    verifyOtpMock.mockResolvedValue({ data: { user: null, session: null }, error: { code: "otp_expired" } });
    const res = await confirm("?token_hash=abc&type=email");
    expect(cookieHeader(res, CONFIRMED_EMAIL_COOKIE)).toBeUndefined();
  });
});

describe("the confirmation session still ends", () => {
  it("signs out locally after verifying, before the reader reaches login", async () => {
    await confirm("?token_hash=abc&type=email");
    expect(signOutMock).toHaveBeenCalledWith({ scope: "local" });
    expect(signOutMock.mock.invocationCallOrder[0]).toBeGreaterThan(verifyOtpMock.mock.invocationCallOrder[0]);
  });
});
