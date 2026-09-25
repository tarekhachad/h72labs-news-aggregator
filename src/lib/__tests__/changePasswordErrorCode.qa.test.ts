import { describe, expect, it } from "vitest";
import { CHANGE_PASSWORD_ERROR_MESSAGES, changePasswordErrorCode } from "@/lib/authErrors";

// Production Auth's own log for a wrong current password on PUT /user.
const PROD_WRONG_CURRENT = {
  status: 400,
  code: "current_password_invalid",
  message: "Current password required when setting new password.",
};

describe("changePasswordErrorCode: current-password codes", () => {
  it("maps production's exact wrong-current-password response", () => {
    expect(changePasswordErrorCode(PROD_WRONG_CURRENT)).toBe("wrong_current_password");
    expect(CHANGE_PASSWORD_ERROR_MESSAGES[changePasswordErrorCode(PROD_WRONG_CURRENT)]).toBe(
      "Your current password is incorrect."
    );
  });

  it.each([
    ["current_password_invalid", {}],
    ["current_password_invalid", { message: "" }],
    ["current_password_invalid", { message: "totally unrelated wording" }],
    ["current_password_invalid", { status: 422 }],
    ["current_password_required", {}],
    ["current_password_required", { message: "Something reworded" }],
    ["current_password_required", { status: 400, message: "Current password required when setting new password." }],
  ])("code %s with %j decides on its own", (code, rest) => {
    expect(changePasswordErrorCode({ code, ...rest })).toBe("wrong_current_password");
  });

  it("never turns Auth's 'required' wording into the app's 'enter your current password' code", () => {
    expect(changePasswordErrorCode(PROD_WRONG_CURRENT)).not.toBe("current_password_required");
    expect(changePasswordErrorCode({ code: "current_password_required" })).not.toBe("current_password_required");
  });

  it("codes match exactly: a different-case code falls through to the message fallback", () => {
    expect(changePasswordErrorCode({ code: "CURRENT_PASSWORD_INVALID" })).toBe("change_failed");
    expect(changePasswordErrorCode({ code: "current_password_invalid " })).toBe("change_failed");
  });
});

describe("changePasswordErrorCode: code takes precedence over message", () => {
  it.each([
    [{ code: "same_password", message: "New password must differ from the current password." }, "same_password"],
    [{ code: "weak_password", message: "Current password is fine but the new one is weak." }, "weak_password"],
    [{ code: "over_request_rate_limit", message: "Too many current password attempts" }, "rate_limited"],
  ])("%j maps to %s, not wrong_current_password", (error, expected) => {
    expect(changePasswordErrorCode(error)).toBe(expected);
  });

  it("the message fallback still works when no code is present", () => {
    expect(changePasswordErrorCode({ status: 400, message: "Current password required when setting new password." })).toBe(
      "wrong_current_password"
    );
    expect(changePasswordErrorCode({ message: "Invalid CURRENT PASSWORD" })).toBe("wrong_current_password");
  });

  it("the message fallback still works under an unrecognised code", () => {
    expect(changePasswordErrorCode({ code: "validation_failed", message: "Current password required" })).toBe(
      "wrong_current_password"
    );
  });
});

describe("changePasswordErrorCode: unchanged mappings", () => {
  it.each([
    [{ code: "same_password" }, "same_password"],
    [{ code: "same_password", status: 422, message: "New password should be different from the old password." }, "same_password"],
    [{ code: "weak_password" }, "weak_password"],
    [{ code: "weak_password", status: 422, message: "Password should contain at least one character" }, "weak_password"],
    [{ status: 429 }, "rate_limited"],
    [{ status: 429, code: "same_password" }, "rate_limited"],
    [{ status: 429, code: "current_password_invalid", message: "Current password required" }, "rate_limited"],
    [{ code: "over_request_rate_limit" }, "rate_limited"],
    [{ code: "over_request_rate_limit", status: 400 }, "rate_limited"],
    [{ code: "over_email_send_rate_limit" }, "change_failed"],
    [{ code: "unexpected_failure", message: "db lock timeout" }, "change_failed"],
    [{ status: 500 }, "change_failed"],
    [{ message: "" }, "change_failed"],
    [{}, "change_failed"],
  ])("%j -> %s", (error, expected) => {
    expect(changePasswordErrorCode(error)).toBe(expected);
  });
});
