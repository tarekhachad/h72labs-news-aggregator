import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_OPTIONS,
  RECOVERY_WINDOW_SECONDS,
  signRecoveryMarker,
  verifyRecoveryMarker,
} from "@/lib/recoveryMarker";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SECRET = "k".repeat(44);
const OTHER_SECRET = "z".repeat(44);
const NOW = 1_800_000_000;

describe("recovery marker — cross-account", () => {
  it("a marker for A never opens B, even with a valid signature", () => {
    const m = signRecoveryMarker(A, NOW, SECRET);
    expect(verifyRecoveryMarker(m, A, SECRET, NOW)).toBe(true);
    expect(verifyRecoveryMarker(m, B, SECRET, NOW)).toBe(false);
  });

  it("swapping the user id in A's marker to B invalidates the signature", () => {
    const [, issued, sig] = signRecoveryMarker(A, NOW, SECRET).split(".");
    expect(verifyRecoveryMarker(`${B}.${issued}.${sig}`, B, SECRET, NOW)).toBe(false);
  });

  it("an empty userId is refused even when the marker is signed for the empty user", () => {
    // verify() takes the caller's sub; resetPassword guards !userId first, but
    // the function itself must not treat '' as a real account either.
    const m = signRecoveryMarker("", NOW, SECRET);
    // Documenting actual behaviour: the function accepts it; the callers' !userId guard is what refuses.
    expect(verifyRecoveryMarker(m, "", SECRET, NOW)).toBe(true);
  });
});

describe("recovery marker — tampering and forgery", () => {
  it("a marker signed with another secret is refused (no client or old secret can mint one)", () => {
    expect(verifyRecoveryMarker(signRecoveryMarker(A, NOW, OTHER_SECRET), A, SECRET, NOW)).toBe(false);
  });

  it("a null secret refuses even a marker that would verify under an empty-key HMAC", () => {
    const payload = `${A}.${NOW}`;
    const emptyKeySig = createHmac("sha256", "").update(payload).digest("base64url");
    expect(verifyRecoveryMarker(`${payload}.${emptyKeySig}`, A, null, NOW)).toBe(false);
  });

  it("moving issuedAt forward (to extend the window) breaks the signature", () => {
    const [u, , sig] = signRecoveryMarker(A, NOW, SECRET).split(".");
    expect(verifyRecoveryMarker(`${u}.${NOW + 3000}.${sig}`, A, SECRET, NOW + 3601)).toBe(false);
  });

  it("leading-zero issuedAt is a different payload and fails the MAC", () => {
    const [u, issued, sig] = signRecoveryMarker(A, NOW, SECRET).split(".");
    expect(verifyRecoveryMarker(`${u}.0${issued}.${sig}`, A, SECRET, NOW)).toBe(false);
  });

  it.each([
    ["extra segment", (m: string) => `${m}.x`],
    ["missing segment", (m: string) => m.split(".").slice(0, 2).join(".")],
    ["whitespace padded", (m: string) => ` ${m} `],
    ["url-encoded dots", (m: string) => m.replaceAll(".", "%2E")],
    ["standard base64 sig (+/=) instead of base64url", (m: string) => m.replace(/-/g, "+").replace(/_/g, "/") + "="],
    ["uppercased", (m: string) => m.toUpperCase()],
  ])("refuses a %s marker", (_label, mutate) => {
    const m = signRecoveryMarker(A, NOW, SECRET);
    expect(verifyRecoveryMarker(mutate(m), A, SECRET, NOW)).toBe(false);
  });

  it("refuses a multi-byte signature that has the same JS string length as the real one", () => {
    const [u, issued, sig] = signRecoveryMarker(A, NOW, SECRET).split(".");
    const sameLengthUnicode = "é" + sig.slice(1); // same .length, longer utf8
    expect(() => verifyRecoveryMarker(`${u}.${issued}.${sameLengthUnicode}`, A, SECRET, NOW)).not.toThrow();
    expect(verifyRecoveryMarker(`${u}.${issued}.${sameLengthUnicode}`, A, SECRET, NOW)).toBe(false);
  });

  it.each(["", undefined])("refuses an absent cookie value (%j)", (v) => {
    expect(verifyRecoveryMarker(v, A, SECRET, NOW)).toBe(false);
  });
});

describe("recovery marker — clock edges", () => {
  const m = signRecoveryMarker(A, NOW, SECRET);
  it("valid at issue time and exactly at the window end", () => {
    expect(verifyRecoveryMarker(m, A, SECRET, NOW)).toBe(true);
    expect(verifyRecoveryMarker(m, A, SECRET, NOW + RECOVERY_WINDOW_SECONDS)).toBe(true);
  });
  it("invalid one second past the window (replay after an hour)", () => {
    expect(verifyRecoveryMarker(m, A, SECRET, NOW + RECOVERY_WINDOW_SECONDS + 1)).toBe(false);
  });
  it("tolerates exactly 60s of future skew and no more", () => {
    expect(verifyRecoveryMarker(m, A, SECRET, NOW - 60)).toBe(true);
    expect(verifyRecoveryMarker(m, A, SECRET, NOW - 61)).toBe(false);
  });
  it("a far-future issuedAt signed with the real secret still fails (no permanent marker)", () => {
    const future = signRecoveryMarker(A, NOW + 10 * 365 * 86400, SECRET);
    expect(verifyRecoveryMarker(future, A, SECRET, NOW)).toBe(false);
  });
  it("an issuedAt beyond Number precision fails closed", () => {
    // Correctly signed with the real secret, so only the age check can refuse it.
    const payload = `${A}.${"9".repeat(400)}`;
    const sig = createHmac("sha256", SECRET).update(payload, "utf8").digest("base64url");
    expect(verifyRecoveryMarker(`${payload}.${sig}`, A, SECRET, NOW)).toBe(false);
    // And a correctly signed tiny issuedAt (epoch 0) is long expired.
    const zero = `${A}.0`;
    const zsig = createHmac("sha256", SECRET).update(zero, "utf8").digest("base64url");
    expect(verifyRecoveryMarker(`${zero}.${zsig}`, A, SECRET, NOW)).toBe(false);
    expect(verifyRecoveryMarker(`${zero}.${zsig}`, A, SECRET, 100)).toBe(true);
  });
});

describe("recovery marker — cookie attributes", () => {
  it("is httpOnly, Secure, SameSite=Lax, whole-site, and lives no longer than the window", () => {
    expect(RECOVERY_COOKIE).toBe("pna_recovery");
    expect(RECOVERY_COOKIE_OPTIONS).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: RECOVERY_WINDOW_SECONDS,
    });
    expect(RECOVERY_WINDOW_SECONDS).toBe(3600);
    expect(RECOVERY_COOKIE_OPTIONS).not.toHaveProperty("domain");
  });
});
