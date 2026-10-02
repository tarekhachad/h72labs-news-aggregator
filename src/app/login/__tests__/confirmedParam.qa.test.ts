// QA: which `confirmed` values show the message on
// /login, how it sits next to an error, and that / sends a profile-less user
// to /onboarding after they sign in.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { default: LoginPage } = await import("@/app/login/page");

const MESSAGE = "Your email is confirmed. Sign in with the password you just chose.";

async function renderLogin(params: Record<string, string | string[] | undefined>): Promise<string> {
  // Next hands a repeated query key over as an array.
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params as { error?: string; confirmed?: string }) }));
}

describe("/login confirmed parameter", () => {
  it("shows exactly once for confirmed=1", async () => {
    const html = await renderLogin({ confirmed: "1" });
    expect(html.split(MESSAGE)).toHaveLength(2);
  });

  it.each([["true"], ["01"], [" 1"], ["1 "], [""], ["2"], ["1.0"], ["<script>alert(1)</script>"]])(
    "does not show for confirmed=%j",
    async (v) => {
      const html = await renderLogin({ confirmed: v });
      expect(html).not.toContain(MESSAGE);
      expect(html).not.toContain("alert(1)");
    }
  );

  it("a repeated key (?confirmed=1&confirmed=1) arrives as an array and does not crash the page", async () => {
    const html = await renderLogin({ confirmed: ["1", "1"] });
    expect(html).toContain('name="email"');
  });

  it("confirmed=1 alongside a known error shows both, the error still as an error", async () => {
    const html = await renderLogin({ confirmed: "1", error: "invalid_credentials" });
    expect(html).toContain(MESSAGE);
    expect(html).toContain('name="password"');
  });

  it("confirmed=1 alongside an unknown error code shows only the message", async () => {
    const html = await renderLogin({ confirmed: "1", error: "<b>x</b>" });
    expect(html).toContain(MESSAGE);
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("/ after sign-in sends a user with no topics or sources to /onboarding", () => {
  it.each([
    [[], []],
    [["tech-ai"], []],
    [[], ["bbc"]],
  ])("topics=%j sources=%j -> /onboarding", async (topics, preferredSources) => {
    vi.resetModules();
    const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); });
    vi.doMock("next/navigation", () => ({ redirect }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) } }),
    }));
    vi.doMock("@/lib/profile", () => ({ getUserProfile: async () => ({ topics, preferredSources, timeZone: "UTC" }) }));
    const getTodayDigest = vi.fn();
    vi.doMock("@/lib/digests", () => ({ getTodayDigest }));
    vi.doMock("@/components/newspaper/FrontPage", () => ({ FrontPage: () => null }));
    vi.doMock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));
    const { default: Home } = await import("@/app/(paper)/page");
    await expect(Home()).rejects.toThrow("REDIRECT:/onboarding");
    expect(getTodayDigest).not.toHaveBeenCalled();
  });

  it("a user with both goes on to load today's digest", async () => {
    vi.resetModules();
    const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); });
    vi.doMock("next/navigation", () => ({ redirect }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) } }),
    }));
    vi.doMock("@/lib/profile", () => ({ getUserProfile: async () => ({ topics: ["tech-ai"], preferredSources: ["bbc"], timeZone: "UTC" }) }));
    const getTodayDigest = vi.fn(async () => null);
    vi.doMock("@/lib/digests", () => ({ getTodayDigest }));
    vi.doMock("@/components/newspaper/FrontPage", () => ({ FrontPage: () => null }));
    vi.doMock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));
    const { default: Home } = await import("@/app/(paper)/page");
    await Home();
    expect(redirect).not.toHaveBeenCalled();
    expect(getTodayDigest).toHaveBeenCalledWith(expect.anything(), "u1", "UTC");
  });
});
