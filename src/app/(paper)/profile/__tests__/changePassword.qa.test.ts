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

beforeEach(() => {
  getUserMock.mockReset();
  getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
  updateUserMock.mockReset();
  updateUserMock.mockResolvedValue({ error: null });
});

describe("changePassword — validation order", () => {
  it("reports missing current password even when the new password is also weak", async () => {
    // Both currentPassword and newPassword are invalid here; the current-
    // password check must win so a caller with no current password never
    // learns anything about the new-password policy.
    const url = await redirectOf({ currentPassword: "", newPassword: "x", confirmPassword: "x" });
    expect(url).toBe("/profile?pwError=current_password_required");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("reports weak password even when confirmation also mismatches", async () => {
    const url = await redirectOf({
      currentPassword: "old-password",
      newPassword: "abc",
      confirmPassword: "xyz",
    });
    expect(url).toBe("/profile?pwError=weak_password");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("never forwards current_password as anything other than a non-empty string to Auth", async () => {
    await redirectOf({ currentPassword: "  ", newPassword: "new-password", confirmPassword: "new-password" });
    // Whitespace-only is still a non-empty string by this action's own rule
    // (length === 0 check only), so it should be forwarded verbatim, not
    // silently trimmed or substituted.
    expect(updateUserMock).toHaveBeenCalledWith({
      password: "new-password",
      current_password: "  ",
    });
  });
});
