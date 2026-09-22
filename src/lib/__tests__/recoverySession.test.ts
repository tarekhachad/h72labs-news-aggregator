import { describe, expect, it } from "vitest";
import { isRecoverySession } from "@/lib/recoverySession";

const NOW = 1_800_000_000;
const HOUR = 60 * 60;

function claims(amr: unknown) {
  return { amr };
}

describe("isRecoverySession", () => {
  it("accepts a session the recovery link just established", () => {
    expect(isRecoverySession(claims([{ method: "recovery", timestamp: NOW - 30 }]), NOW)).toBe(true);
  });

  // What Auth actually records for a token-hash email link, confirmed against
  // auth.mfa_amr_claims on a real reset: the narrower "recovery" value alone
  // would reject every genuine link.
  it("accepts the otp method Auth records for an email link", () => {
    expect(isRecoverySession(claims([{ method: "otp", timestamp: NOW - 30 }]), NOW)).toBe(true);
  });

  it("still rejects an otp entry once it is stale", () => {
    expect(isRecoverySession(claims([{ method: "otp", timestamp: NOW - HOUR - 1 }]), NOW)).toBe(false);
  });

  it("accepts a recovery entry alongside other methods", () => {
    const amr = [
      { method: "recovery", timestamp: NOW - 120 },
      { method: "token_refresh", timestamp: NOW - 10 },
    ];
    expect(isRecoverySession(claims(amr), NOW)).toBe(true);
  });

  it.each([
    ["password", "an ordinary login"],
    ["magiclink", "a magic link"],
    ["oauth", "a social login"],
    ["email/signup", "the signup confirmation itself"],
  ])("rejects a %s session (%s)", (method) => {
    expect(isRecoverySession(claims([{ method, timestamp: NOW - 30 }]), NOW)).toBe(false);
  });

  it("rejects a recovery older than the one-hour window", () => {
    expect(isRecoverySession(claims([{ method: "recovery", timestamp: NOW - HOUR - 1 }]), NOW)).toBe(
      false
    );
  });

  it("accepts a recovery exactly at the window edge", () => {
    expect(isRecoverySession(claims([{ method: "recovery", timestamp: NOW - HOUR }]), NOW)).toBe(true);
  });

  it("tolerates small clock drift but rejects a timestamp far in the future", () => {
    expect(isRecoverySession(claims([{ method: "recovery", timestamp: NOW + 30 }]), NOW)).toBe(true);
    expect(isRecoverySession(claims([{ method: "recovery", timestamp: NOW + 600 }]), NOW)).toBe(false);
  });

  const failsClosed: Array<[unknown, string]> = [
    [undefined, "no claims at all"],
    [null, "null claims"],
    [{}, "claims with no amr"],
    [claims("recovery"), "amr as a bare string"],
    [claims([{ method: "recovery" }]), "a recovery entry with no timestamp"],
    [claims([{ method: "recovery", timestamp: "recent" }]), "a non-numeric timestamp"],
    [claims([]), "an empty amr array"],
  ];

  for (const [value, description] of failsClosed) {
    it(`fails closed on ${description}`, () => {
      expect(isRecoverySession(value, NOW)).toBe(false);
    });
  }
});
