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
const signInMock = vi.fn();
const resendMock = vi.fn();
const resetPasswordForEmailMock = vi.fn();
const updateUserMock = vi.fn();
const signOutMock = vi.fn();
const getClaimsMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signUp: signUpMock,
      signInWithPassword: signInMock,
      resend: resendMock,
      resetPasswordForEmail: resetPasswordForEmailMock,
      updateUser: updateUserMock,
      signOut: signOutMock,
      getClaims: getClaimsMock,
    },
  })),
}));

let markerCookie: string | undefined;
const cookieDeleteMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "pna_recovery" && markerCookie !== undefined ? { name, value: markerCookie } : undefined,
    delete: cookieDeleteMock,
  })),
}));

const { signUp, signIn, resendConfirmation, requestPasswordReset, resetPassword } = await import(
  "@/app/auth/actions"
);
const { RECOVERY_COOKIE, signRecoveryMarker } = await import("@/lib/recoveryMarker");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MARKER_SECRET = "s".repeat(44);
const nowSeconds = () => Math.floor(Date.now() / 1000);

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const VALID_TOKEN = "a".repeat(43);

async function captureRedirect(
  action: (fd: FormData) => Promise<unknown>,
  fd: FormData
): Promise<string> {
  try {
    await action(fd);
    throw new Error("action did not redirect");
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
}

function runAndCaptureRedirect(fd: FormData): Promise<string> {
  return captureRedirect(signUp, fd);
}

beforeEach(() => {
  signUpMock.mockReset();
  signInMock.mockReset();
  resendMock.mockReset();
  resetPasswordForEmailMock.mockReset();
  updateUserMock.mockReset();
  signOutMock.mockReset();
  getClaimsMock.mockReset();
  // The default is a session with a fresh recovery marker, as a verified
  // reset link leaves it; the tests that care about the gate override it.
  getClaimsMock.mockResolvedValue({ data: { claims: { sub: USER_ID } } });
  vi.stubEnv("RECOVERY_MARKER_SECRET", MARKER_SECRET);
  markerCookie = signRecoveryMarker(USER_ID, nowSeconds(), MARKER_SECRET);
  cookieDeleteMock.mockReset();
  signOutMock.mockResolvedValue({ error: null });
  // A session in the signUp response is the "confirmation is off" shape;
  // tests that care about the confirmation path override this.
  signUpMock.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
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
    signUpMock.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
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

describe("signUp with email confirmation on", () => {
  it("sends a session-less signup to check-email, not to onboarding", async () => {
    signUpMock.mockResolvedValue({ data: { user: { id: "u1" }, session: null }, error: null });
    const url = await runAndCaptureRedirect(
      form({ invite: VALID_TOKEN, email: "a@b.com", password: "password1" })
    );
    expect(url).toBe(`/signup/check-email?${new URLSearchParams({ email: "a@b.com" }).toString()}`);
  });

  it("sends an already-registered address to the same place, revealing nothing", async () => {
    // Supabase returns a decoy user with no identities and no session here.
    signUpMock.mockResolvedValue({
      data: { user: { id: "decoy", identities: [] }, session: null },
      error: null,
    });
    const url = await runAndCaptureRedirect(
      form({ invite: VALID_TOKEN, email: "taken@b.com", password: "password1" })
    );
    expect(url).toBe(
      `/signup/check-email?${new URLSearchParams({ email: "taken@b.com" }).toString()}`
    );
  });
});

describe("signIn error mapping", () => {
  it.each([
    [{ code: "invalid_credentials", message: "Invalid login credentials" }, "invalid_credentials"],
    [{ code: "email_not_confirmed", message: "Email not confirmed" }, "email_not_confirmed"],
    [{ status: 429, code: "over_request_rate_limit", message: "…" }, "rate_limited"],
    [{ code: "unexpected_failure", message: "Database error granting user" }, "login_failed"],
    // Message-only shape, i.e. an SDK that does not populate `code`.
    [{ message: "Email not confirmed" }, "email_not_confirmed"],
  ])("maps %o to the %s code", async (error, expected) => {
    signInMock.mockResolvedValue({ error });
    const url = await captureRedirect(signIn, form({ email: "a@b.com", password: "password1" }));
    expect(url).toBe(`/login?error=${expected}`);
  });

  it("never puts Supabase's raw error text in the redirect URL", async () => {
    signInMock.mockResolvedValue({
      error: { code: "unexpected_failure", message: "Database error granting user" },
    });
    const url = await captureRedirect(signIn, form({ email: "a@b.com", password: "password1" }));
    expect(url).not.toContain("Database");
    expect(url).not.toContain(encodeURIComponent("Database error granting user"));
  });

  it("redirects to / on success", async () => {
    signInMock.mockResolvedValue({ error: null });
    const url = await captureRedirect(signIn, form({ email: "a@b.com", password: "password1" }));
    expect(url).toBe("/");
  });
});

describe("resendConfirmation", () => {
  it("resends for a valid address and reports it neutrally", async () => {
    resendMock.mockResolvedValue({ error: null });
    const url = await captureRedirect(resendConfirmation, form({ email: "a@b.com" }));
    expect(resendMock).toHaveBeenCalledWith({ type: "signup", email: "a@b.com" });
    expect(url).toBe("/signup/check-email?sent=1");
  });

  it("gives the same answer when Supabase errors, so a failure reveals nothing", async () => {
    resendMock.mockResolvedValue({ error: { code: "user_not_found", message: "User not found" } });
    const url = await captureRedirect(resendConfirmation, form({ email: "nobody@b.com" }));
    expect(url).toBe("/signup/check-email?sent=1");
  });

  it("gives the same answer for a malformed address, without calling Supabase", async () => {
    const url = await captureRedirect(resendConfirmation, form({ email: "not-an-email" }));
    expect(resendMock).not.toHaveBeenCalled();
    expect(url).toBe("/signup/check-email?sent=1");
  });
});

describe("requestPasswordReset", () => {
  it("sends the reset email and reports it neutrally", async () => {
    resetPasswordForEmailMock.mockResolvedValue({ error: null });
    const url = await captureRedirect(requestPasswordReset, form({ email: "a@b.com" }));
    expect(resetPasswordForEmailMock).toHaveBeenCalledWith("a@b.com");
    expect(url).toBe("/forgot-password?sent=1");
  });

  it("answers identically for an unknown address", async () => {
    resetPasswordForEmailMock.mockResolvedValue({
      error: { code: "user_not_found", message: "User not found" },
    });
    const url = await captureRedirect(requestPasswordReset, form({ email: "nobody@b.com" }));
    expect(url).toBe("/forgot-password?sent=1");
  });

  it("answers identically for a malformed address, without calling Supabase", async () => {
    const url = await captureRedirect(requestPasswordReset, form({ email: "nope" }));
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled();
    expect(url).toBe("/forgot-password?sent=1");
  });
});

describe("resetPassword", () => {
  it("updates the password, spends the marker, then signs out every other session", async () => {
    updateUserMock.mockResolvedValue({ error: null });
    const url = await captureRedirect(resetPassword, form({ password: "newpassword" }));
    expect(updateUserMock).toHaveBeenCalledWith({ password: "newpassword" });
    expect(cookieDeleteMock).toHaveBeenCalledWith(RECOVERY_COOKIE);
    expect(signOutMock).toHaveBeenCalledWith({ scope: "others" });
    expect(url).toBe("/");
  });

  it("still lands on / when eviction fails, since the password already changed", async () => {
    updateUserMock.mockResolvedValue({ error: null });
    signOutMock.mockResolvedValue({ error: { message: "network" } });
    const url = await captureRedirect(resetPassword, form({ password: "newpassword" }));
    expect(url).toBe("/");
  });

  it("rejects a short password before calling Supabase", async () => {
    const url = await captureRedirect(resetPassword, form({ password: "abc" }));
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(url).toBe("/reset-password?error=weak_password");
  });

  it("reports a failed update without spending the marker or signing anyone out", async () => {
    updateUserMock.mockResolvedValue({
      error: { code: "session_expired", message: "Session from session_id claim in JWT does not exist" },
    });
    const url = await captureRedirect(resetPassword, form({ password: "newpassword" }));
    expect(cookieDeleteMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(url).toBe("/reset-password?error=reset_failed");
  });

  const refused: Array<[() => void, string]> = [
    [() => { markerCookie = undefined; }, "a session with no marker (e.g. a signup confirmation)"],
    [() => { markerCookie = signRecoveryMarker("22222222-2222-4222-8222-222222222222", nowSeconds(), MARKER_SECRET); }, "another account's marker"],
    [() => { markerCookie = signRecoveryMarker(USER_ID, nowSeconds() - 7200, MARKER_SECRET); }, "a stale marker"],
    [() => { markerCookie = signRecoveryMarker(USER_ID, nowSeconds(), "x".repeat(44)); }, "a forged marker"],
    [() => { vi.stubEnv("RECOVERY_MARKER_SECRET", ""); }, "a missing secret"],
    [() => { getClaimsMock.mockResolvedValue({ data: null }); }, "no session at all"],
  ];

  for (const [arrange, description] of refused) {
    it(`refuses ${description} without touching the password or other sessions`, async () => {
      arrange();
      const url = await captureRedirect(resetPassword, form({ password: "newpassword" }));
      expect(updateUserMock).not.toHaveBeenCalled();
      expect(signOutMock).not.toHaveBeenCalled();
      expect(url).toBe("/forgot-password?expired=1");
    });
  }

  it("checks the marker before validating the password, so a bad session never reveals the rule", async () => {
    markerCookie = undefined;
    const url = await captureRedirect(resetPassword, form({ password: "abc" }));
    expect(url).toBe("/forgot-password?expired=1");
  });

  it("names the same-password case so the user can act on it", async () => {
    updateUserMock.mockResolvedValue({
      error: { code: "same_password", message: "New password should be different from the old password." },
    });
    const url = await captureRedirect(resetPassword, form({ password: "newpassword" }));
    expect(url).toBe("/reset-password?error=same_password");
  });
});
