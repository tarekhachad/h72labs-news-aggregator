import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// /reset-password's one field: a show/hide button and the rule, with the
// attributes the resetPassword action reads left as they were.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SID = "99999999-9999-4999-8999-999999999999";
const SECRET = "s".repeat(44);
vi.stubEnv("RECOVERY_MARKER_SECRET", SECRET);

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: USER_ID, session_id: SID } } }) },
  })),
}));

let marker = "";
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: (name: string) => (name === "pna_recovery" ? { name, value: marker } : undefined) })),
}));

const { default: ResetPasswordPage } = await import("@/app/reset-password/page");
const { markerSubject, signRecoveryMarker } = await import("@/lib/recoveryMarker");

describe("/reset-password's password field", () => {
  it("has a show button that can't submit, the rule, and keeps name, required and minLength", async () => {
    marker = signRecoveryMarker(markerSubject(USER_ID, SID), Math.floor(Date.now() / 1000), SECRET);
    const html = renderToStaticMarkup(await ResetPasswordPage({ searchParams: Promise.resolve({}) }));
    const input = html.match(/<input[^>]*name="password"[^>]*>/)![0];
    expect(input).toContain('type="password"');
    expect(input).toContain("required");
    expect(input).toContain('minLength="6"');
    expect(input).toContain('placeholder="New password"');
    expect(html).toMatch(/<button type="button"[^>]*aria-label="Show password"/);
    expect(html).toContain("At least 6 characters");
  });
});
