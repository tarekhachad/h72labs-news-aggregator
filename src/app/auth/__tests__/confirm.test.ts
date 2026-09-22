import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyOtpMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { verifyOtp: verifyOtpMock },
  })),
}));

const { GET } = await import("@/app/auth/confirm/route");

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
  verifyOtpMock.mockResolvedValue({ error: null });
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
});
