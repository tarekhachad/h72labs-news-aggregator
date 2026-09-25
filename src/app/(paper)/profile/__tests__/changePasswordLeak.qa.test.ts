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
  createClient: vi.fn(async () => ({ auth: { getUser: getUserMock, updateUser: updateUserMock } })),
}));

const { changePassword } = await import("@/app/(paper)/profile/actions");
const { CHANGE_PASSWORD_ERROR_MESSAGES, changePasswordErrorCode, isChangePasswordErrorCode } = await import(
  "@/lib/authErrors"
);

async function redirectOf(fd: FormData): Promise<string> {
  try {
    await changePassword(fd);
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("no redirect");
}
const ok = () => {
  const fd = new FormData();
  fd.set("currentPassword", "old-pw-123");
  fd.set("newPassword", "new-pw-456");
  fd.set("confirmPassword", "new-pw-456");
  return fd;
};

beforeEach(() => {
  getUserMock.mockReset();
  getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
  updateUserMock.mockReset();
  updateUserMock.mockResolvedValue({ data: {}, error: null });
});

const CODE_URL = /^\/profile\?pwError=([a-z_]+)$/;

describe("changePassword never puts Supabase text in the URL", () => {
  it.each([
    { code: "same_password", status: 422, message: "New password should be different from the old password." },
    { code: "weak_password", status: 422, message: "Password should contain at least one character of each: abc" },
    { code: "over_request_rate_limit", status: 429, message: "Request rate limit reached" },
    { status: 429, message: "For security purposes, you can only request this after 37 seconds." },
    { code: "reauthentication_needed", status: 400, message: "Password update requires reauthentication." },
    { code: "validation_failed", status: 400, message: "Current password required when setting new password." },
    { status: 400, message: "Invalid current password" },
    { status: 500, message: "pq: duplicate key value violates unique constraint \"users_pkey\" <script>x</script>" },
    { message: "" },
    {},
  ])("error %j maps to a fixed, known code", async (error) => {
    updateUserMock.mockResolvedValue({ data: { user: null }, error });
    const url = await redirectOf(ok());
    const m = url.match(CODE_URL);
    expect(m, url).not.toBeNull();
    expect(isChangePasswordErrorCode(m![1])).toBe(true);
    if (error.message) expect(url).not.toContain(encodeURIComponent(error.message).slice(0, 12));
  });

  it("forwards the current password to Auth exactly, alongside the new one", async () => {
    expect(await redirectOf(ok())).toBe("/profile?pwSaved=1");
    expect(updateUserMock).toHaveBeenCalledWith({ password: "new-pw-456", current_password: "old-pw-123" });
  });

  it.each(["currentPassword", "newPassword", "confirmPassword"])(
    "a File submitted as %s never reaches Auth",
    async (field) => {
      const fd = ok();
      fd.set(field, new File(["new-pw-456"], "x.txt"));
      const url = await redirectOf(fd);
      expect(url).toMatch(CODE_URL);
      expect(updateUserMock).not.toHaveBeenCalled();
    }
  );

  it("a missing currentPassword field is refused before Auth", async () => {
    const fd = ok();
    fd.delete("currentPassword");
    expect(await redirectOf(fd)).toBe("/profile?pwError=current_password_required");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("no session: /login and Auth is never asked to update", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    expect(await redirectOf(ok())).toBe("/login");
    expect(updateUserMock).not.toHaveBeenCalled();
  });
});

describe("changePasswordErrorCode", () => {
  it("429 wins over any code", () => {
    expect(changePasswordErrorCode({ status: 429, code: "same_password" })).toBe("rate_limited");
  });
  it("recognises a refused current password by message, case-insensitively", () => {
    expect(changePasswordErrorCode({ status: 400, message: "Current Password Required when setting new password." })).toBe(
      "wrong_current_password"
    );
  });
  it("every code has a message, and the guard rejects prototype keys", () => {
    for (const k of Object.keys(CHANGE_PASSWORD_ERROR_MESSAGES)) expect(isChangePasswordErrorCode(k)).toBe(true);
    for (const k of ["toString", "__proto__", "constructor", "hasOwnProperty", "", undefined]) {
      expect(isChangePasswordErrorCode(k as string | undefined)).toBe(false);
    }
  });
});
