import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { default: LoginPage } = await import("@/app/login/page");

const MESSAGE = "Your email is confirmed. Sign in with the password you just chose.";

async function renderLogin(params: { error?: string; confirmed?: string }): Promise<string> {
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
}

describe("/login?confirmed=1", () => {
  it("shows the confirmed message as a status, not an error", async () => {
    const html = await renderLogin({ confirmed: "1" });
    expect(html).toContain(MESSAGE);
    expect(html).toMatch(/<p role="status"[^>]*>Your email is confirmed\./);
    expect(html).not.toContain("--color-destructive");
  });

  it("still shows the sign-in form under it", async () => {
    const html = await renderLogin({ confirmed: "1" });
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
  });

  it.each([{}, { confirmed: "0" }, { confirmed: "yes" }, { error: "invalid_credentials" }])(
    "does not show it for %j",
    async (params) => {
      expect(await renderLogin(params)).not.toContain(MESSAGE);
    }
  );
});
