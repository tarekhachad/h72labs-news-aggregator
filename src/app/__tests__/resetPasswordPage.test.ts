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

let markerCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "pna_recovery" && markerCookie !== undefined ? { name, value: markerCookie } : undefined,
  })),
}));

const { default: ResetPasswordPage } = await import("@/app/reset-password/page");
const { signRecoveryMarker } = await import("@/lib/recoveryMarker");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const SECRET = "s".repeat(44);
const now = () => Math.floor(Date.now() / 1000);

function searchParams(params: Record<string, string> = {}) {
  return Promise.resolve(params);
}

async function expectRefused() {
  await expect(ResetPasswordPage({ searchParams: searchParams() })).rejects.toMatchObject({
    url: "/forgot-password?expired=1",
  });
}

beforeEach(() => {
  getClaimsMock.mockReset();
  getClaimsMock.mockResolvedValue({ data: { claims: { sub: USER_ID } } });
  markerCookie = undefined;
  vi.stubEnv("RECOVERY_MARKER_SECRET", SECRET);
});

describe("ResetPasswordPage gate", () => {
  it("renders the form when a fresh marker for this user is present", async () => {
    markerCookie = signRecoveryMarker(USER_ID, now(), SECRET);
    const element = await ResetPasswordPage({ searchParams: searchParams() });
    expect(JSON.stringify(element)).toContain("Set a new password");
  });

  // The case the old amr gate let through: a session from a signup
  // confirmation carries the same `otp` method as a reset link, and only the
  // marker tells them apart.
  it("refuses a signed-in session with no marker, whatever its amr says", async () => {
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: USER_ID, amr: [{ method: "otp", timestamp: now() }] } },
    });
    await expectRefused();
  });

  it("refuses a marker issued to a different account", async () => {
    markerCookie = signRecoveryMarker(OTHER_USER, now(), SECRET);
    await expectRefused();
  });

  it("refuses a marker older than the window", async () => {
    markerCookie = signRecoveryMarker(USER_ID, now() - 2 * 60 * 60, SECRET);
    await expectRefused();
  });

  it("refuses a marker signed with a different secret", async () => {
    markerCookie = signRecoveryMarker(USER_ID, now(), "x".repeat(44));
    await expectRefused();
  });

  it("refuses everything when the secret is not configured", async () => {
    markerCookie = signRecoveryMarker(USER_ID, now(), SECRET);
    vi.stubEnv("RECOVERY_MARKER_SECRET", "");
    await expectRefused();
  });

  it("refuses a marker with no session behind it", async () => {
    markerCookie = signRecoveryMarker(USER_ID, now(), SECRET);
    getClaimsMock.mockResolvedValue({ data: null });
    await expectRefused();
  });
});
