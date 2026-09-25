import { beforeEach, describe, expect, it, vi } from "vitest";

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

const getUserMock = vi.fn();
const updateUserMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: getUserMock, updateUser: updateUserMock },
  })),
}));

const { changePassword } = await import("@/app/(paper)/profile/actions");
const { isChangePasswordErrorCode } = await import("@/lib/authErrors");

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function redirectOf(fields: Record<string, string>): Promise<string> {
  try {
    await changePassword(form(fields));
    throw new Error("action did not redirect");
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
}

const VALID = { currentPassword: "old-password", newPassword: "new-password", confirmPassword: "new-password" };

beforeEach(() => {
  getUserMock.mockReset();
  getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
  updateUserMock.mockReset();
  updateUserMock.mockResolvedValue({ error: null });
});

describe("changePassword", () => {
  it("sends the current password to Auth along with the new one", async () => {
    expect(await redirectOf(VALID)).toBe("/profile?pwSaved=1");
    expect(updateUserMock).toHaveBeenCalledWith({ password: "new-password", current_password: "old-password" });
  });

  it("refuses without a current password, before calling Auth", async () => {
    expect(await redirectOf({ ...VALID, currentPassword: "" })).toBe("/profile?pwError=current_password_required");
    expect(await redirectOf({ newPassword: VALID.newPassword, confirmPassword: VALID.confirmPassword })).toBe("/profile?pwError=current_password_required");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("refuses a short new password, before calling Auth", async () => {
    expect(await redirectOf({ ...VALID, newPassword: "abc", confirmPassword: "abc" })).toBe(
      "/profile?pwError=weak_password"
    );
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("refuses mismatched confirmation, before calling Auth", async () => {
    expect(await redirectOf({ ...VALID, confirmPassword: "other-password" })).toBe(
      "/profile?pwError=password_mismatch"
    );
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("sends a signed-out caller to login", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    expect(await redirectOf(VALID)).toBe("/login");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it.each([
    // The exact response production's Auth gave a wrong current password.
    [{ code: "current_password_invalid", status: 400, message: "Current password required when setting new password." }, "wrong_current_password"],
    [{ code: "current_password_invalid", message: "Something reworded" }, "wrong_current_password"],
    [{ message: "Current password required when setting new password." }, "wrong_current_password"],
    [{ code: "same_password", message: "New password should be different." }, "same_password"],
    [{ code: "reauthentication_needed", message: "Reauthentication required" }, "reauth_required"],
    [{ code: "reauthentication_not_valid", message: "Nonce invalid" }, "reauth_required"],
    [{ code: "reauth_nonce_missing", message: "Nonce missing" }, "reauth_required"],
    [{ code: "weak_password", message: "Password is too weak" }, "weak_password"],
    [{ status: 429, message: "Too many requests" }, "rate_limited"],
    [{ code: "unexpected_failure", message: "db: relation auth.users lock timeout" }, "change_failed"],
  ])("maps %j to a code, never to Supabase's text", async (error, code) => {
    updateUserMock.mockResolvedValue({ error });
    const url = await redirectOf(VALID);
    expect(url).toBe(`/profile?pwError=${code}`);
    expect(isChangePasswordErrorCode(code)).toBe(true);
    expect(url).not.toContain(encodeURIComponent(error.message).slice(0, 12));
  });
});
