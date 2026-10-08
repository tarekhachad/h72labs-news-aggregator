import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// /login fills the email from the confirmed-email cookie, shows the invite
// line instead of a link to the invite-only signup page, and gives the
// password field a show/hide button.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

let jar: Record<string, string> = {};
const getMock = vi.fn((name: string) => (name in jar ? { name, value: jar[name] } : undefined));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: getMock })) }));

const { default: LoginPage } = await import("@/app/login/page");
const { CONFIRMED_EMAIL_COOKIE } = await import("@/app/login/confirmedEmail");

async function render(params: { error?: string; confirmed?: string } = {}): Promise<string> {
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
}

function emailInput(html: string): string {
  return html.match(/<input[^>]*name="email"[^>]*>/)![0];
}

beforeEach(() => {
  jar = {};
  getMock.mockClear();
});

describe("email prefill", () => {
  it("fills the field from the cookie after a confirmation", async () => {
    jar[CONFIRMED_EMAIL_COOKIE] = "reader+news@example.com";
    const input = emailInput(await render({ confirmed: "1" }));
    expect(input).toContain('value="reader+news@example.com"');
    expect(input).toContain('type="email"');
    expect(input).toContain("required");
  });

  it("keeps it filled after a wrong password sends the reader back", async () => {
    jar[CONFIRMED_EMAIL_COOKIE] = "reader@example.com";
    expect(emailInput(await render({ error: "invalid_credentials" }))).toContain('value="reader@example.com"');
  });

  it("leaves the field empty with no cookie", async () => {
    expect(emailInput(await render({ confirmed: "1" }))).not.toContain("value=");
  });

  it.each([
    ["markup", '"><script>alert(1)</script>'],
    ["not an address", "nope"],
    ["an empty value", ""],
  ])("leaves the field empty for a cookie holding %s", async (_, value) => {
    jar[CONFIRMED_EMAIL_COOKIE] = value;
    const html = await render({ confirmed: "1" });
    expect(emailInput(html)).not.toContain("value=");
    expect(html).not.toContain("<script>alert");
  });

  it("reads no cookie but its own", async () => {
    jar = { pna_recovery: "a@b.co", other: "a@b.co" };
    expect(emailInput(await render())).not.toContain("value=");
    expect(getMock.mock.calls.map((c) => c[0])).toEqual([CONFIRMED_EMAIL_COOKIE]);
  });
});

describe("the invite line", () => {
  it("replaces the Sign up link with plain text", async () => {
    const html = await render();
    expect(html).toContain("Have an invite? Use the link in your invite email.");
    expect(html).not.toContain('href="/signup"');
    expect(html).not.toContain(">Sign up<");
  });

  it("keeps the forgot-password link", async () => {
    expect(await render()).toContain('href="/forgot-password"');
  });
});

describe("the password field", () => {
  it("has a show button that cannot submit the form, and keeps its name and required", async () => {
    const html = await render();
    const input = html.match(/<input[^>]*name="password"[^>]*>/)![0];
    expect(input).toContain('type="password"');
    expect(input).toContain("required");
    expect(input).not.toContain("autoComplete");
    expect(html).toMatch(/<button type="button"[^>]*aria-label="Show password"/);
  });

  it("shows no new-password rule on login", async () => {
    expect(await render()).not.toContain("At least 6 characters");
  });
});
