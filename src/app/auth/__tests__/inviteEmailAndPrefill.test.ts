import { beforeEach, describe, expect, it, vi } from "vitest";

// The signup and sign-in actions' side of the invite email and the
// confirmed-email cookie: the email in an invite link is display only, and
// the cookie is spent once the reader is signed in.

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
const updateUserMock = vi.fn();
const getClaimsMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signUp: signUpMock,
      signInWithPassword: signInMock,
      updateUser: updateUserMock,
      getClaims: getClaimsMock,
      getUser: getUserMock,
      signOut: vi.fn(async () => ({ error: null })),
    },
  })),
}));

let markerCookie: string | undefined;
const cookieDeleteMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "pna_recovery" && markerCookie ? { name, value: markerCookie } : undefined),
    delete: cookieDeleteMock,
  })),
}));

const { signUp, signIn, resetPassword } = await import("@/app/auth/actions");
const { changePassword } = await import("@/app/(paper)/profile/actions");
const { MIN_PASSWORD_LENGTH, NEW_PASSWORD_RULE } = await import("@/components/authStyles");
const { CONFIRMED_EMAIL_COOKIE, CONFIRMED_EMAIL_PATH } = await import("@/app/login/confirmedEmail");
const { markerSubject, signRecoveryMarker } = await import("@/lib/recoveryMarker");

const TOKEN = "a".repeat(43);
const INVITED = "invitee@example.com";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function redirectOf(action: (fd: FormData) => Promise<unknown>, fd: FormData): Promise<string> {
  try {
    await action(fd);
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("action did not redirect");
}

const params = (url: string) => new URL(url, "https://x.test").searchParams;

beforeEach(() => {
  vi.clearAllMocks();
  markerCookie = undefined;
  signUpMock.mockResolvedValue({ data: { session: null }, error: null });
  signInMock.mockResolvedValue({ error: null });
});

describe("signUp with a locked invite email", () => {
  it("submits whatever address the form sent, so the hook, not the link, decides the match", async () => {
    // A tampered link locks the field to an address the invite isn't for; a
    // reader who edits the read-only field in devtools sends another. Either
    // way the action passes the submitted address through unchanged.
    await redirectOf(
      signUp,
      form({ invite: TOKEN, invitedEmail: "tampered@example.com", email: "typed@example.com", password: "secret1" })
    );
    expect(signUpMock).toHaveBeenCalledWith({
      email: "typed@example.com",
      password: "secret1",
      options: { data: { invite_token: TOKEN } },
    });
  });

  it("sends nothing about invitedEmail to Auth: the hook only ever sees the token and the submitted email", async () => {
    await redirectOf(signUp, form({ invite: TOKEN, invitedEmail: INVITED, email: INVITED, password: "secret1" }));
    expect(JSON.stringify(signUpMock.mock.calls[0][0])).not.toContain("invitedEmail");
  });

  it("drops the lock when the hook says the address isn't the invite's, leaving an editable field as for a wrong typed email", async () => {
    signUpMock.mockResolvedValue({ data: null, error: { message: "invite_email_mismatch" } });
    const url = await redirectOf(
      signUp,
      form({ invite: TOKEN, invitedEmail: "tampered@example.com", email: "tampered@example.com", password: "secret1" })
    );
    expect(url).toBe(`/signup?invite=${TOKEN}&error=invite_email_mismatch`);
  });

  it.each(["invite_invalid", "invite_required", "some other failure"])(
    "keeps the lock through a %s refusal",
    async (message) => {
      signUpMock.mockResolvedValue({ data: null, error: { message } });
      const url = await redirectOf(signUp, form({ invite: TOKEN, invitedEmail: INVITED, email: INVITED, password: "secret1" }));
      expect(params(url).get("invite")).toBe(TOKEN);
      expect(params(url).get("email")).toBe(INVITED);
    }
  );

  it("keeps the lock through a short password, refused before Auth is called", async () => {
    const url = await redirectOf(signUp, form({ invite: TOKEN, invitedEmail: INVITED, email: INVITED, password: "12345" }));
    expect(url).toBe(`/signup?invite=${TOKEN}&email=invitee%40example.com&error=weak_password`);
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it("never locks a typed address: a link without an email stays editable after a refusal", async () => {
    const url = await redirectOf(signUp, form({ invite: TOKEN, email: "typed@example.com", password: "12345" }));
    expect(url).toBe(`/signup?invite=${TOKEN}&error=weak_password`);
  });

  it.each([
    ["markup", "<b>x</b>@example.com"],
    ["not an address", "nope"],
    ["a header-injection attempt", "a@b.co\r\nSet-Cookie: x=y"],
  ])("does not carry an invitedEmail that is %s into the redirect", async (_, value) => {
    const url = await redirectOf(signUp, form({ invite: TOKEN, invitedEmail: value, email: INVITED, password: "12345" }));
    expect(url).toBe(`/signup?invite=${TOKEN}&error=weak_password`);
  });

  it("drops a malformed token before anything else, lock or not", async () => {
    const url = await redirectOf(signUp, form({ invite: "short", invitedEmail: INVITED, email: INVITED, password: "secret1" }));
    expect(url).toBe("/signup?error=invite_invalid");
  });
});

describe("signIn spends the confirmed-email cookie", () => {
  it("deletes it, at the path it was set with, once sign-in succeeds", async () => {
    expect(await redirectOf(signIn, form({ email: INVITED, password: "secret1" }))).toBe("/");
    expect(cookieDeleteMock).toHaveBeenCalledWith({ name: CONFIRMED_EMAIL_COOKIE, path: CONFIRMED_EMAIL_PATH });
  });

  it("keeps it through a wrong password, so the field is still filled on the retry", async () => {
    signInMock.mockResolvedValue({ error: { code: "invalid_credentials", status: 400 } });
    expect(await redirectOf(signIn, form({ email: INVITED, password: "secret1" }))).toBe("/login?error=invalid_credentials");
    expect(cookieDeleteMock).not.toHaveBeenCalled();
  });

  it("keeps it through a refusal before Auth is called", async () => {
    await redirectOf(signIn, form({ email: "nope", password: "secret1" }));
    expect(cookieDeleteMock).not.toHaveBeenCalled();
  });
});

describe(`the "${NEW_PASSWORD_RULE}" rule matches what the server refuses`, () => {
  const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
  const enough = "x".repeat(MIN_PASSWORD_LENGTH);

  it("signUp", async () => {
    expect(params(await redirectOf(signUp, form({ invite: TOKEN, email: INVITED, password: short }))).get("error")).toBe(
      "weak_password"
    );
    await redirectOf(signUp, form({ invite: TOKEN, email: INVITED, password: enough }));
    expect(signUpMock).toHaveBeenCalledTimes(1);
  });

  it("changePassword", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    const fields = (pw: string) => form({ currentPassword: "old-one", newPassword: pw, confirmPassword: pw });
    expect(await redirectOf(changePassword, fields(short))).toBe("/profile?pwError=weak_password");
    updateUserMock.mockResolvedValue({ error: null });
    expect(await redirectOf(changePassword, fields(enough))).toBe("/profile?pwSaved=1");
  });

  it("resetPassword", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const sid = "99999999-9999-4999-8999-999999999999";
    const secret = "s".repeat(44);
    vi.stubEnv("RECOVERY_MARKER_SECRET", secret);
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: userId, session_id: sid } } });
    markerCookie = signRecoveryMarker(markerSubject(userId, sid), Math.floor(Date.now() / 1000), secret);
    updateUserMock.mockResolvedValue({ error: null });

    expect(await redirectOf(resetPassword, form({ password: short }))).toBe("/reset-password?error=weak_password");
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(await redirectOf(resetPassword, form({ password: enough }))).toBe("/");
    expect(updateUserMock).toHaveBeenCalledWith({ password: enough });
    vi.unstubAllEnvs();
  });
});
