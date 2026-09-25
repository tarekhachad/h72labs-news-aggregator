import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECOVERY_WINDOW_SECONDS,
  recoverySecret,
  signRecoveryMarker,
  verifyRecoveryMarker,
} from "@/lib/recoveryMarker";

const USER = "11111111-1111-4111-8111-111111111111";
const SECRET = "s".repeat(44);
const NOW = 1_800_000_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifyRecoveryMarker", () => {
  it("accepts a marker it signed, for the same user, inside the window", () => {
    const marker = signRecoveryMarker(USER, NOW, SECRET);
    expect(verifyRecoveryMarker(marker, USER, SECRET, NOW)).toBe(true);
    expect(verifyRecoveryMarker(marker, USER, SECRET, NOW + RECOVERY_WINDOW_SECONDS)).toBe(true);
  });

  it("refuses once the window has passed", () => {
    const marker = signRecoveryMarker(USER, NOW, SECRET);
    expect(verifyRecoveryMarker(marker, USER, SECRET, NOW + RECOVERY_WINDOW_SECONDS + 1)).toBe(false);
  });

  it("refuses a marker dated far in the future", () => {
    const marker = signRecoveryMarker(USER, NOW + 3600, SECRET);
    expect(verifyRecoveryMarker(marker, USER, SECRET, NOW)).toBe(false);
  });

  it("refuses another user's marker", () => {
    const marker = signRecoveryMarker("22222222-2222-4222-8222-222222222222", NOW, SECRET);
    expect(verifyRecoveryMarker(marker, USER, SECRET, NOW)).toBe(false);
  });

  it("refuses a marker whose timestamp was edited to extend it", () => {
    const [user, , sig] = signRecoveryMarker(USER, NOW - 7200, SECRET).split(".");
    expect(verifyRecoveryMarker(`${user}.${NOW}.${sig}`, USER, SECRET, NOW)).toBe(false);
  });

  it("refuses a marker signed with another secret", () => {
    const marker = signRecoveryMarker(USER, NOW, "x".repeat(44));
    expect(verifyRecoveryMarker(marker, USER, SECRET, NOW)).toBe(false);
  });

  it.each([undefined, "", "garbage", `${USER}.${NOW}`, `${USER}.abc.sig`, `${USER}.${NOW}.sig.extra`])(
    "refuses a malformed value %j",
    (value) => {
      expect(verifyRecoveryMarker(value, USER, SECRET, NOW)).toBe(false);
    }
  );

  it("refuses everything without a secret", () => {
    const marker = signRecoveryMarker(USER, NOW, SECRET);
    expect(verifyRecoveryMarker(marker, USER, null, NOW)).toBe(false);
  });
});

describe("recoverySecret", () => {
  it("returns a secret of at least 32 characters", () => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", SECRET);
    expect(recoverySecret()).toBe(SECRET);
  });

  it.each(["", "short"])("returns null for %j", (value) => {
    vi.stubEnv("RECOVERY_MARKER_SECRET", value);
    expect(recoverySecret()).toBeNull();
  });
});
