// A signed-in visitor opening a recovery link while RECOVERY_MARKER_SECRET is
// missing: /auth/confirm refuses it unspent and sends them to
// /login?error=reset_unavailable, and the proxy must let that one URL render
// instead of bouncing a live user to /.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { AuthApiError } from "@supabase/supabase-js";

const verifyOtpMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { verifyOtp: verifyOtpMock } })),
}));

const getClaimsMock = vi.fn();
const getSessionMock = vi.fn();
const getUserMock = vi.fn();
const adminSignOutMock = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getClaims: getClaimsMock, getSession: getSessionMock, getUser: getUserMock, admin: { signOut: adminSignOutMock } },
  })),
}));

const { proxy } = await import("@/proxy");
const { GET: confirm } = await import("@/app/auth/confirm/route");
const { default: LoginPage } = await import("@/app/login/page");
const { LOGIN_ERROR_MESSAGES } = await import("@/lib/authErrors");

const ORIGIN = "https://news.h72labs.com";
const SESSION = "sb-127-auth-token";
const signedIn = (url: string) => new NextRequest(new Request(url, { headers: { cookie: `${SESSION}=base64-x; theme=dark` } }));
const expired = (res: Response) =>
  res.headers.getSetCookie().filter((l) => /max-age=0/i.test(l)).map((l) => l.slice(0, l.indexOf("=")));
const MESSAGE = LOGIN_ERROR_MESSAGES.reset_unavailable.replace(/'/g, "&#x27;");

// Next hands a page a repeated query key as an array.
function searchParamsAsNext(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length === 1 ? all[0] : all;
  }
  return out;
}
async function renderLoginAt(url: URL): Promise<string> {
  const props = { searchParams: Promise.resolve(searchParamsAsNext(url)) } as Parameters<typeof LoginPage>[0];
  return renderToStaticMarkup(await LoginPage(props));
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  getClaimsMock.mockReset().mockResolvedValue({ data: { claims: { sub: "user-1" } } });
  getSessionMock.mockReset().mockResolvedValue({ data: { session: { access_token: "token-1" } }, error: null });
  getUserMock.mockReset().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  adminSignOutMock.mockReset().mockResolvedValue({ data: null, error: null });
  verifyOtpMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a signed-in visitor sent to /login?error=reset_unavailable", () => {
  it("end to end: the link is refused unspent, the proxy lets /login render, and the page shows the message", async () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "");
    const refused = await confirm(new Request(`${ORIGIN}/auth/confirm?token_hash=th&type=recovery&next=/reset-password`));
    const landing = refused.headers.get("location")!;
    expect(landing).toBe(`${ORIGIN}/login?error=reset_unavailable`);
    expect(verifyOtpMock).not.toHaveBeenCalled();

    const res = await proxy(signedIn(landing));
    expect(res.headers.get("location")).toBeNull();
    expect(await renderLoginAt(new URL(landing))).toContain(MESSAGE);
  });

  it("is still checked with Auth, and a live session's cookies are left alone", async () => {
    const res = await proxy(signedIn(`${ORIGIN}/login?error=reset_unavailable`));
    expect(getUserMock).toHaveBeenCalledWith("token-1");
    expect(adminSignOutMock).not.toHaveBeenCalled();
    expect(expired(res)).toEqual([]);
  });

  it("keeps rendering when other query keys ride along", async () => {
    const res = await proxy(signedIn(`${ORIGIN}/login?error=reset_unavailable&confirmed=1`));
    expect(res.headers.get("location")).toBeNull();
  });

  it("a token Auth rejects is still revoked and cleared, and /login renders as before", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new AuthApiError("gone", 403, "user_not_found") });
    const res = await proxy(signedIn(`${ORIGIN}/login?error=reset_unavailable`));
    expect(res.headers.get("location")).toBeNull();
    expect(adminSignOutMock).toHaveBeenCalledWith("token-1", "local");
    expect(expired(res)).toEqual([SESSION]);
  });
});

describe("every other signed-in visit to /login or /signup still goes to /", () => {
  it.each([
    "/login",
    "/login?error=link_expired",
    "/login?error=invalid_credentials",
    "/login?error=reset_unavailable_x",
    "/login?error=RESET_UNAVAILABLE",
    "/login?error=",
    "/login?error=reset_unavailable&error=reset_unavailable",
    "/login?error=reset_unavailable&error=link_expired",
    "/login?Error=reset_unavailable",
    "/login?reset_unavailable",
    "/signup?error=reset_unavailable",
  ])("%s", async (path) => {
    const res = await proxy(signedIn(`${ORIGIN}${path}`));
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    expect(new URL(location!).pathname).toBe("/");
  });

  // The page shows nothing for a repeated code, so letting it through would
  // render a bare login form to a live user.
  it("the page indeed renders no message for a repeated code", async () => {
    expect(await renderLoginAt(new URL(`${ORIGIN}/login?error=reset_unavailable&error=reset_unavailable`))).not.toContain(MESSAGE);
  });
});
