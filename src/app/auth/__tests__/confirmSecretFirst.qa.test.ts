import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyOtpMock = vi.fn();
const createClientMock = vi.fn(async () => ({ auth: { verifyOtp: verifyOtpMock } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));

const cookieSetMock = vi.fn();
const cookiesMock = vi.fn(async () => ({ set: cookieSetMock }));
vi.mock("next/headers", () => ({ cookies: cookiesMock }));

const { GET } = await import("@/app/auth/confirm/route");

const ORIGIN = "https://news.h72labs.com";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const tok = (sid: string) => `h.${Buffer.from(JSON.stringify({ session_id: sid })).toString("base64url")}.s`;

async function hit(query: string) {
  const res = await GET(new Request(`${ORIGIN}/auth/confirm${query}`));
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  verifyOtpMock.mockReset();
  verifyOtpMock.mockResolvedValue({ data: { user: { id: USER_ID }, session: { access_token: tok("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") } }, error: null });
  createClientMock.mockClear();
  cookieSetMock.mockReset();
  cookiesMock.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/auth/confirm refuses a no-secret recovery link before touching Auth", () => {
  it("never builds a Supabase client, never opens the cookie store, sets no cookie", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "");
    const r = await hit("?token_hash=abc&type=recovery&next=/reset-password");
    expect(r.location).toBe(`${ORIGIN}/login?error=reset_unavailable`);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(verifyOtpMock).not.toHaveBeenCalled();
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(r.setCookie).toBeNull();
  });

  it("ignores next= on the refusal (no open redirect via the new branch)", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "short");
    const r = await hit("?token_hash=abc&type=recovery&next=https://evil.example/x");
    expect(r.location).toBe(`${ORIGIN}/login?error=reset_unavailable`);
  });

  it("the token hash never appears in the refusal URL", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "");
    const r = await hit("?token_hash=SECRET_HASH_123&type=recovery");
    expect(r.location).not.toContain("SECRET_HASH_123");
  });

  it("a recovery URL without a token_hash still says link_expired (not reset_unavailable) and verifies nothing", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "");
    const r = await hit("?type=recovery&next=/reset-password");
    expect(r.location).toBe(`${ORIGIN}/login?error=link_expired`);
    expect(verifyOtpMock).not.toHaveBeenCalled();
  });

  it.each(["magiclink", "invite", "email_change", "RECOVERY", "recovery "])(
    "an unaccepted type %j with no secret is link_expired and never verified",
    async (type) => {
      vi.stubEnv("RECOVERY_MARKER_SECRET", "");
      const r = await hit(`?token_hash=abc&type=${encodeURIComponent(type)}`);
      expect(r.location).toBe(`${ORIGIN}/login?error=link_expired`);
      expect(verifyOtpMock).not.toHaveBeenCalled();
    }
  );

  it("a signup link with a too-short secret is still verified and lands on next", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "x".repeat(31));
    const r = await hit("?token_hash=abc&type=email&next=/onboarding");
    expect(verifyOtpMock).toHaveBeenCalledWith({ type: "email", token_hash: "abc" });
    expect(r.location).toBe(`${ORIGIN}/onboarding`);
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("with a valid secret, a failed recovery verification is link_expired and mints nothing", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "s".repeat(44));
    verifyOtpMock.mockResolvedValue({ data: { user: null, session: null }, error: { message: "Token has expired or is invalid", code: "otp_expired" } });
    const r = await hit("?token_hash=abc&type=recovery&next=/reset-password");
    expect(r.location).toBe(`${ORIGIN}/login?error=link_expired`);
    expect(r.location).not.toContain("expired or is invalid");
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("the secret is read once per request: rotating it mid-flight can't mint with a missing secret", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "s".repeat(44));
    verifyOtpMock.mockImplementation(async () => {
      vi.stubEnv("RECOVERY_MARKER_SECRET", "");
      return { data: { user: { id: USER_ID }, session: { access_token: tok("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") } }, error: null };
    });
    const r = await hit("?token_hash=abc&type=recovery&next=/reset-password");
    expect(r.location).toBe(`${ORIGIN}/reset-password`);
    expect(cookieSetMock).toHaveBeenCalledTimes(1);
  });
});
