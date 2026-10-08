import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// /signup with and without the invitee's email in the link.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { default: SignupPage } = await import("@/app/signup/page");
const { SIGNUP_ERROR_MESSAGES } = await import("@/lib/invite");

const TOKEN = "a".repeat(43);

async function render(params: Record<string, string | string[] | undefined>): Promise<string> {
  return renderToStaticMarkup(
    await SignupPage({ searchParams: Promise.resolve(params as { error?: string; invite?: string; email?: string }) })
  );
}

function emailInput(html: string): string {
  return html.match(/<input[^>]*name="email"[^>]*>/)![0];
}

// renderToStaticMarkup HTML-escapes apostrophes.
const esc = (s: string) => s.replace(/'/g, "&#x27;");

describe("a link with the invitee's email", () => {
  it('says who is signing up and locks the field to that address', async () => {
    const html = await render({ invite: TOKEN, email: "reader@example.com" });
    expect(html).toContain("Signing up as");
    expect(html).toContain("reader@example.com</span>");
    const input = emailInput(html);
    expect(input).toContain('value="reader@example.com"');
    expect(input).toContain("readOnly");
    expect(input).toContain("required");
    expect(input).not.toContain("disabled");
  });

  it("tells the action which address was locked", async () => {
    const html = await render({ invite: TOKEN, email: "reader@example.com" });
    expect(html).toContain('<input type="hidden" name="invitedEmail" value="reader@example.com"/>');
  });

  it("shows the address lowercased, as Auth stores it", async () => {
    const html = await render({ invite: TOKEN, email: "Reader@Example.COM" });
    expect(emailInput(html)).toContain('value="reader@example.com"');
  });

  it("keeps the lock alongside a refusal the action sent back", async () => {
    const html = await render({ invite: TOKEN, email: "reader@example.com", error: "weak_password" });
    expect(html).toContain("Signing up as");
    expect(html).toContain(SIGNUP_ERROR_MESSAGES.weak_password);
  });
});

describe("a link without a usable email keeps the editable field", () => {
  it.each([
    ["no email (every link minted before this)", undefined],
    ["an empty email", ""],
    ["something that isn't an address", "not-an-email"],
    ["markup", "<img src=x onerror=alert(1)>@example.com"],
    ["a repeated key", ["a@example.com", "b@example.com"]],
  ])("%s", async (_, email) => {
    const html = await render({ invite: TOKEN, email });
    expect(html).not.toContain("Signing up as");
    expect(html).not.toContain("invitedEmail");
    const input = emailInput(html);
    expect(input).not.toContain("readOnly");
    expect(input).not.toContain("value=");
    expect(input).toContain('placeholder="Email"');
    expect(html).not.toContain("<img");
    expect(html).toContain(`name="invite" value="${TOKEN}"`);
  });
});

describe("no well-formed invite", () => {
  it.each([{ email: "reader@example.com" }, { invite: "short", email: "reader@example.com" }])(
    "shows the refusal and never the address (%j)",
    async (params) => {
      const html = await render(params);
      expect(html).toContain(esc(SIGNUP_ERROR_MESSAGES.invite_required));
      expect(html).not.toContain("reader@example.com");
      expect(html).not.toContain("<form");
    }
  );
});

describe("the password field", () => {
  it("has a show button and the rule, and keeps name, required and minLength", async () => {
    const html = await render({ invite: TOKEN, email: "reader@example.com" });
    const input = html.match(/<input[^>]*name="password"[^>]*>/)![0];
    expect(input).toContain('type="password"');
    expect(input).toContain("required");
    expect(input).toContain('minLength="6"');
    expect(html).toMatch(/<button type="button"[^>]*aria-label="Show password"/);
    expect(html).toContain("At least 6 characters");
  });
});
