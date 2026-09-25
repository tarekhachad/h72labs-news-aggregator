import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyOtpMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { verifyOtp: verifyOtpMock },
  })),
}));

const cookieSetMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: cookieSetMock })),
}));

const { GET } = await import("@/app/auth/confirm/route");
const { RECOVERY_COOKIE, markerSubject, verifyRecoveryMarker } = await import("@/lib/recoveryMarker");
const SID = "99999999-9999-4999-8999-999999999999";
// A token shaped like Auth's: only the payload's session_id is read.
const freshToken = (sessionId: string) =>
  `h.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString("base64url")}.s`;


const USER_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "s".repeat(44);

const ORIGIN = "https://news.h72labs.com";
const EXPIRED = `${ORIGIN}/login?error=link_expired`;

function request(query: string): Request {
  return new Request(`${ORIGIN}/auth/confirm${query}`);
}

async function locationOf(query: string): Promise<string> {
  const response = await GET(request(query));
  return response.headers.get("location") ?? "";
}

beforeEach(() => {
  verifyOtpMock.mockReset();
  verifyOtpMock.mockResolvedValue({ data: { user: { id: USER_ID }, session: { access_token: freshToken(SID) } }, error: null });
  cookieSetMock.mockReset();
  vi.stubEnv("RECOVERY_MARKER_SECRET", SECRET);
});

describe("GET /auth/confirm", () => {
  it("verifies a signup link and lands on the requested page", async () => {
    const location = await locationOf("?token_hash=abc123&type=email&next=/onboarding");
    expect(verifyOtpMock).toHaveBeenCalledWith({ type: "email", token_hash: "abc123" });
    expect(location).toBe(`${ORIGIN}/onboarding`);
  });

  it("verifies a recovery link and lands on the reset page", async () => {
    const location = await locationOf("?token_hash=abc123&type=recovery&next=/reset-password");
    expect(verifyOtpMock).toHaveBeenCalledWith({ type: "recovery", token_hash: "abc123" });
    expect(location).toBe(`${ORIGIN}/reset-password`);
  });

  it("falls back to the root when no next is given", async () => {
    expect(await locationOf("?token_hash=abc123&type=email")).toBe(`${ORIGIN}/`);
  });

  it.each([
    ["//evil.example/", "protocol-relative"],
    ["@evil.example/", "userinfo-style"],
    ["https://evil.example/", "absolute"],
  ])("refuses a %s next target (%s), sending the user to the root instead", async (next) => {
    const location = await locationOf(
      `?token_hash=abc123&type=email&next=${encodeURIComponent(next)}`
    );
    expect(location).toBe(`${ORIGIN}/`);
    expect(location).not.toContain("evil.example");
  });

  it.each(["magiclink", "invite", "email_change", "sms", ""])(
    "refuses the %s type without calling Supabase",
    async (type) => {
      const location = await locationOf(`?token_hash=abc123&type=${type}`);
      expect(verifyOtpMock).not.toHaveBeenCalled();
      expect(location).toBe(EXPIRED);
    }
  );

  it("refuses a request with no token hash", async () => {
    expect(await locationOf("?type=email")).toBe(EXPIRED);
    expect(verifyOtpMock).not.toHaveBeenCalled();
  });

  it("sends an expired or already-used token to login with a code, not Supabase's text", async () => {
    verifyOtpMock.mockResolvedValue({
      error: { code: "otp_expired", message: "Email link is invalid or has expired" },
    });
    const location = await locationOf("?token_hash=stale&type=email&next=/onboarding");
    expect(location).toBe(EXPIRED);
    expect(location).not.toContain("expired&");
    expect(location).not.toContain(encodeURIComponent("Email link is invalid"));
  });

  describe("recovery marker", () => {
    it("sets a signed, HttpOnly marker for this user after a verified recovery link", async () => {
      await locationOf("?token_hash=abc123&type=recovery&next=/reset-password");
      expect(cookieSetMock).toHaveBeenCalledTimes(1);
      const [name, value, options] = cookieSetMock.mock.calls[0];
      expect(name).toBe(RECOVERY_COOKIE);
      expect(verifyRecoveryMarker(value, markerSubject(USER_ID, SID), SECRET)).toBe(true);
      expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    });

    it("sets no marker for a signup confirmation", async () => {
      await locationOf("?token_hash=abc123&type=email&next=/onboarding");
      expect(cookieSetMock).not.toHaveBeenCalled();
    });

    it("sets no marker when the recovery link fails to verify", async () => {
      verifyOtpMock.mockResolvedValue({ data: { user: null }, error: { code: "otp_expired" } });
      await locationOf("?token_hash=stale&type=recovery&next=/reset-password");
      expect(cookieSetMock).not.toHaveBeenCalled();
    });

    it("sets no marker and says reset is unavailable when the secret is missing", async () => {
      vi.stubEnv("RECOVERY_MARKER_SECRET", "");
      const location = await locationOf("?token_hash=abc123&type=recovery&next=/reset-password");
      expect(cookieSetMock).not.toHaveBeenCalled();
      expect(location).toBe(`${ORIGIN}/login?error=reset_unavailable`);
      // Refused before verifying, so no session is created and the link isn't spent.
      expect(verifyOtpMock).not.toHaveBeenCalled();
    });

    it("still verifies a signup link when the recovery secret is missing", async () => {
      vi.stubEnv("RECOVERY_MARKER_SECRET", "");
      const location = await locationOf("?token_hash=abc123&type=email&next=/onboarding");
      expect(verifyOtpMock).toHaveBeenCalledTimes(1);
      expect(location).toBe(`${ORIGIN}/onboarding`);
    });

    it("binds the marker to the session the link just created", async () => {
      await locationOf("?token_hash=abc123&type=recovery&next=/reset-password");
      const [, value] = cookieSetMock.mock.calls[0];
      expect(verifyRecoveryMarker(value, markerSubject(USER_ID, "88888888-8888-4888-8888-888888888888"), SECRET)).toBe(false);
    });

    it("sets no marker when Auth returns no session to bind it to", async () => {
      verifyOtpMock.mockResolvedValue({ data: { user: { id: USER_ID }, session: null }, error: null });
      await locationOf("?token_hash=abc123&type=recovery&next=/reset-password");
      expect(cookieSetMock).not.toHaveBeenCalled();
    });
  });
});
