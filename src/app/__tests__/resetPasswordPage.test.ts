import { beforeEach, describe, expect, it, vi } from "vitest";

// Same pattern as src/app/auth/__tests__/actions.test.ts: redirect() throws
// for real, so the page's early-return-by-redirect is exercised rather than
// assumed.
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

const getClaimsMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getClaims: getClaimsMock },
  })),
}));

const { default: ResetPasswordPage } = await import("@/app/reset-password/page");

function searchParams(params: Record<string, string> = {}) {
  return Promise.resolve(params);
}

beforeEach(() => {
  getClaimsMock.mockReset();
});

describe("ResetPasswordPage gate", () => {
  it("renders the form for a fresh recovery session, without redirecting", async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { amr: [{ method: "recovery", timestamp: Math.floor(Date.now() / 1000) }] } },
    });
    const element = await ResetPasswordPage({ searchParams: searchParams() });
    // A JSX tree came back rather than a thrown redirect — confirm the form
    // (and its wired-up action) is actually in it, not just "didn't throw".
    const html = JSON.stringify(element);
    expect(html).toContain("Set a new password");
  });

  const refused: Array<[unknown, string]> = [
    [{ amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] }, "an ordinary login session"],
    [{ amr: [{ method: "recovery", timestamp: Math.floor(Date.now() / 1000) - 7200 }] }, "a stale recovery session"],
    [{ amr: "not-an-array" }, "a garbage amr claim"],
    [{}, "a session with no amr claim at all"],
    [null, "no claims at all"],
  ];

  for (const [claims, description] of refused) {
    it(`redirects instead of rendering for ${description}`, async () => {
      getClaimsMock.mockResolvedValue({ data: { claims } });
      await expect(ResetPasswordPage({ searchParams: searchParams() })).rejects.toThrow(RedirectSignal);
      try {
        await ResetPasswordPage({ searchParams: searchParams() });
      } catch (e) {
        expect((e as RedirectSignal).url).toBe("/forgot-password?expired=1");
      }
    });
  }

  it("redirects when getClaims resolves with no data at all", async () => {
    getClaimsMock.mockResolvedValue({ data: null });
    await expect(ResetPasswordPage({ searchParams: searchParams() })).rejects.toThrow(RedirectSignal);
  });
});
