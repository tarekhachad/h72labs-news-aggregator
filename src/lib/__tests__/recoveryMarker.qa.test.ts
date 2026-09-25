import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverySecret, signRecoveryMarker, verifyRecoveryMarker } from "@/lib/recoveryMarker";

const USER = "11111111-1111-4111-8111-111111111111";
const SECRET = "s".repeat(44);
const NOW = 1_800_000_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifyRecoveryMarker — signature-shape attacks", () => {
  it("refuses a signature with a single bit flipped (same length as a real one)", () => {
    const marker = signRecoveryMarker(USER, NOW, SECRET);
    const [user, issued, sig] = marker.split(".");
    // Flip the first character of the base64url signature to something else,
    // keeping length identical so this exercises timingSafeEqual itself, not
    // just the length guard in front of it.
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyRecoveryMarker(`${user}.${issued}.${flipped}`, USER, SECRET, NOW)).toBe(false);
  });

  it("refuses a truncated signature (exercises the length check, not just timingSafeEqual)", () => {
    const marker = signRecoveryMarker(USER, NOW, SECRET);
    const [user, issued, sig] = marker.split(".");
    expect(verifyRecoveryMarker(`${user}.${issued}.${sig.slice(0, -4)}`, USER, SECRET, NOW)).toBe(false);
  });

  it("refuses a padded/longer signature", () => {
    const marker = signRecoveryMarker(USER, NOW, SECRET);
    const [user, issued, sig] = marker.split(".");
    expect(verifyRecoveryMarker(`${user}.${issued}.${sig}AAAA`, USER, SECRET, NOW)).toBe(false);
  });

  it("refuses an empty signature", () => {
    const marker = signRecoveryMarker(USER, NOW, SECRET);
    const [user, issued] = marker.split(".");
    expect(verifyRecoveryMarker(`${user}.${issued}.`, USER, SECRET, NOW)).toBe(false);
  });

  it("refuses a non-numeric issuedAt that starts with digits (parseInt-style coercion attempt)", () => {
    const marker = signRecoveryMarker(USER, NOW, SECRET);
    const [, , sig] = marker.split(".");
    expect(verifyRecoveryMarker(`${USER}.${NOW}abc.${sig}`, USER, SECRET, NOW)).toBe(false);
  });

  it("treats exactly-at-window-boundary as valid and one second past as invalid", () => {
    const marker = signRecoveryMarker(USER, NOW, SECRET);
    // RECOVERY_WINDOW_SECONDS = 3600
    expect(verifyRecoveryMarker(marker, USER, SECRET, NOW + 3600)).toBe(true);
    expect(verifyRecoveryMarker(marker, USER, SECRET, NOW + 3601)).toBe(false);
  });
});

describe("recoverySecret — boundary length", () => {
  it("refuses a secret one character short of the minimum", () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "s".repeat(31));
    expect(recoverySecret()).toBeNull();
  });

  it("accepts a secret exactly at the minimum length", () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", "s".repeat(32));
    expect(recoverySecret()).toBe("s".repeat(32));
  });
});
