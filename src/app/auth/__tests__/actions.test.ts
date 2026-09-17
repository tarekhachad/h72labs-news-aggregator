import { beforeEach, describe, expect, it, vi } from "vitest";

// next/navigation's real redirect() throws a special NEXT_REDIRECT error to
// unwind the action; mock it the same way so signUp's control flow (the
// early-return-by-throw after a bad invite/credentials) is exercised for
// real rather than assumed.
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

const signUpMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { signUp: signUpMock },
  })),
}));

const { signUp } = await import("@/app/auth/actions");

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const VALID_TOKEN = "a".repeat(43);

async function runAndCaptureRedirect(fd: FormData): Promise<string> {
  try {
    await signUp(fd);
    throw new Error("signUp did not redirect");
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
}

beforeEach(() => {
  signUpMock.mockReset();
});

describe("signUp invite gating", () => {
  it("redirects to invite_required with no invite field at all", async () => {
    const url = await runAndCaptureRedirect(
      form({ email: "a@b.com", password: "password1" })
    );
    expect(url).toBe("/signup?error=invite_required");
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it("redirects to invite_required with an empty invite field", async () => {
    const url = await runAndCaptureRedirect(
      form({ invite: "", email: "a@b.com", password: "password1" })
    );
    expect(url).toBe("/signup?error=invite_required");
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it("redirects to invite_invalid for a malformed (wrong-length) token, never calling Supabase", async () => {
    const url = await runAndCaptureRedirect(
      form({ invite: "short", email: "a@b.com", password: "password1" })
    );
    expect(url).toBe("/signup?error=invite_invalid");
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it("does not leak a raw, unvalidated invite value into the redirect URL on the malformed-token path", async () => {
    const url = await runAndCaptureRedirect(
      form({ invite: "<script>alert(1)</script>", email: "a@b.com", password: "password1" })
    );
    // The invite param itself must not appear verbatim in the redirect target here;
    // the code takes the shortcut branch that omits it entirely.
    expect(url).not.toContain("<script>");
    expect(url).toBe("/signup?error=invite_invalid");
  });

  it("carries a well-formed invite token through to Supabase as options.data.invite_token", async () => {
    signUpMock.mockResolvedValue({ error: null });
    const fd = form({ invite: VALID_TOKEN, email: "a@b.com", password: "password1" });
    let caught: unknown;
    try {
      await signUp(fd);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RedirectSignal);
    expect((caught as RedirectSignal).url).toBe("/onboarding");
    expect(signUpMock).toHaveBeenCalledTimes(1);
    expect(signUpMock).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "password1",
      options: { data: { invite_token: VALID_TOKEN } },
    });
  });

  it("rejects bad credentials before ever calling Supabase, keeping the invite token in the redirect", async () => {
    const url = await runAndCaptureRedirect(
      form({ invite: VALID_TOKEN, email: "not-an-email", password: "password1" })
    );
    expect(url).toBe(`/signup?${new URLSearchParams({ invite: VALID_TOKEN, error: "invalid_email" }).toString()}`);
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it("rejects a too-short password before calling Supabase", async () => {
    const url = await runAndCaptureRedirect(
      form({ invite: VALID_TOKEN, email: "a@b.com", password: "abc" })
    );
    expect(url).toBe(`/signup?${new URLSearchParams({ invite: VALID_TOKEN, error: "weak_password" }).toString()}`);
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it.each([
    ["invite_required", "invite_required"],
    ["invite_invalid", "invite_invalid"],
    ["invite_email_mismatch", "invite_email_mismatch"],
  ])("maps the hook's %s Supabase error straight through", async (supabaseMessage, expectedCode) => {
    signUpMock.mockResolvedValue({ error: { message: supabaseMessage } });
    const url = await runAndCaptureRedirect(
      form({ invite: VALID_TOKEN, email: "a@b.com", password: "password1" })
    );
    expect(url).toBe(`/signup?${new URLSearchParams({ invite: VALID_TOKEN, error: expectedCode }).toString()}`);
  });

  it("never puts Supabase's raw error message in the redirect URL for an unrecognized error", async () => {
    signUpMock.mockResolvedValue({
      error: { message: "User already registered" },
    });
    const url = await runAndCaptureRedirect(
      form({ invite: VALID_TOKEN, email: "a@b.com", password: "password1" })
    );
    expect(url).not.toContain("already registered");
    expect(url).not.toContain(encodeURIComponent("User already registered"));
    expect(url).toBe(`/signup?${new URLSearchParams({ invite: VALID_TOKEN, error: "signup_failed" }).toString()}`);
  });
});
