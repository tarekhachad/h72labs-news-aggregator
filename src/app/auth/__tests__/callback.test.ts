import { beforeEach, describe, expect, it, vi } from "vitest";

const exchangeCodeForSessionMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { exchangeCodeForSession: exchangeCodeForSessionMock },
  })),
}));

const { GET } = await import("@/app/auth/callback/route");

const ORIGIN = "https://news.h72labs.com";
const EXPIRED = `${ORIGIN}/login?error=link_expired`;

function request(query: string): Request {
  return new Request(`${ORIGIN}/auth/callback${query}`);
}

async function locationOf(query: string): Promise<string> {
  const response = await GET(request(query));
  return response.headers.get("location") ?? "";
}

beforeEach(() => {
  exchangeCodeForSessionMock.mockReset();
  exchangeCodeForSessionMock.mockResolvedValue({ error: null });
});

describe("GET /auth/callback", () => {
  it("exchanges a PKCE code and lands on the requested page", async () => {
    const location = await locationOf("?code=abc123&next=/onboarding");
    expect(exchangeCodeForSessionMock).toHaveBeenCalledWith("abc123");
    expect(location).toBe(`${ORIGIN}/onboarding`);
  });

  it("falls back to the root when no next is given", async () => {
    expect(await locationOf("?code=abc123")).toBe(`${ORIGIN}/`);
  });

  it.each([
    ["//evil.example/", "protocol-relative"],
    ["@evil.example/", "userinfo-style"],
    ["https://evil.example/", "absolute"],
  ])("refuses a %s next target (%s), sending the user to the root instead", async (next) => {
    const location = await locationOf(`?code=abc123&next=${encodeURIComponent(next)}`);
    expect(location).toBe(`${ORIGIN}/`);
    expect(location).not.toContain("evil.example");
  });

  it("refuses a request with no code, without calling Supabase", async () => {
    expect(await locationOf("?next=/onboarding")).toBe(EXPIRED);
    expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });

  it("sends a failed exchange to login with a code, not Supabase's text", async () => {
    exchangeCodeForSessionMock.mockResolvedValue({
      error: { message: "invalid request: both auth code and code verifier should be non-empty" },
    });
    const location = await locationOf("?code=stale&next=/onboarding");
    expect(location).toBe(EXPIRED);
    expect(location).not.toContain(encodeURIComponent("code verifier"));
  });
});
