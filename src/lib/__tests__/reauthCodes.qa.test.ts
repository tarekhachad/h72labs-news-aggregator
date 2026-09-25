import { describe, expect, it } from "vitest";
import {
  CHANGE_PASSWORD_ERROR_MESSAGES,
  changePasswordErrorCode,
  isChangePasswordErrorCode,
} from "@/lib/authErrors";

describe("changePasswordErrorCode — reauth codes", () => {
  it.each(["reauthentication_needed", "reauthentication_not_valid", "reauth_nonce_missing"])(
    "%s → reauth_required",
    (code) => {
      expect(changePasswordErrorCode({ code, status: 400, message: "whatever Auth says" })).toBe("reauth_required");
    }
  );

  it("reauth_required is a renderable /profile code with its own message", () => {
    expect(isChangePasswordErrorCode("reauth_required")).toBe(true);
    expect(CHANGE_PASSWORD_ERROR_MESSAGES.reauth_required.length).toBeGreaterThan(0);
  });

  it("429 still wins over a reauth code", () => {
    expect(changePasswordErrorCode({ code: "reauthentication_needed", status: 429 })).toBe("rate_limited");
  });

  it.each(["reauthentication", "reauth_nonce", "REAUTHENTICATION_NEEDED", "reauthentication_needed "])(
    "near-miss code %j is not mapped to reauth_required",
    (code) => {
      expect(changePasswordErrorCode({ code })).toBe("change_failed");
    }
  );

  it("a reauth code whose message mentions 'current password' is still reauth_required (code wins)", () => {
    expect(
      changePasswordErrorCode({ code: "reauthentication_needed", message: "Current password required" })
    ).toBe("reauth_required");
  });

  it("existing mappings are unchanged", () => {
    expect(changePasswordErrorCode({ code: "current_password_invalid" })).toBe("wrong_current_password");
    expect(changePasswordErrorCode({ code: "same_password" })).toBe("same_password");
    expect(changePasswordErrorCode({ code: "weak_password" })).toBe("weak_password");
    expect(changePasswordErrorCode({})).toBe("change_failed");
  });
});
