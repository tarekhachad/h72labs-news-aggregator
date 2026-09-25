import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const getClaimsMock = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({ auth: { getClaims: getClaimsMock } })),
}));

const { default: LoginPage } = await import("@/app/login/page");
const { LOGIN_ERROR_MESSAGES, isLoginErrorCode } = await import("@/lib/authErrors");
const { proxy } = await import("@/proxy");

async function renderLogin(error?: string): Promise<string> {
  const el = await LoginPage({ searchParams: Promise.resolve(error === undefined ? {} : { error }) });
  return renderToStaticMarkup(el);
}

// renderToStaticMarkup HTML-escapes apostrophes.
const esc = (s: string) => s.replace(/'/g, "&#x27;");

beforeEach(() => {
  getClaimsMock.mockReset();
  getClaimsMock.mockResolvedValue({ data: null });
});

describe("/login renders reset_unavailable", () => {
  it("is a known login code", () => {
    expect(isLoginErrorCode("reset_unavailable")).toBe(true);
  });

  it("renders its message, without the 'Send it again' confirmation link", async () => {
    const html = await renderLogin("reset_unavailable");
    expect(html).toContain(esc(LOGIN_ERROR_MESSAGES.reset_unavailable));
    expect(html).not.toContain("Send it again");
  });

  it("renders nothing for an unknown code", async () => {
    const html = await renderLogin("reset_unavailable_x");
    expect(html).not.toContain(esc(LOGIN_ERROR_MESSAGES.reset_unavailable));
  });

  it("the proxy lets an anonymous visitor through to /login?error=reset_unavailable", async () => {
    const res = await proxy(new NextRequest("https://news.h72labs.com/login?error=reset_unavailable"));
    expect(res.headers.get("location")).toBeNull();
  });

  // /auth/confirm refuses a recovery link before verifying it when the
  // secret is missing, so the visitor arrives signed out and the proxy lets
  // /login through.
  it("a signed-out visitor is let through to /login with the code intact", async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: null } });
    const res = await proxy(new NextRequest("https://news.h72labs.com/login?error=reset_unavailable"));
    expect(res.headers.get("location")).toBeNull();
  });
});
