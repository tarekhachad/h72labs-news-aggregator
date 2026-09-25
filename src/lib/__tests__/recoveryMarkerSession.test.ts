import { describe, expect, it } from "vitest";
import {
  markerSubject,
  sessionIdOfFreshToken,
  signRecoveryMarker,
  subjectFromClaims,
  verifyRecoveryMarker,
} from "@/lib/recoveryMarker";

const USER = "11111111-1111-4111-8111-111111111111";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = "s".repeat(44);
const NOW = 1_800_000_000;

const token = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

describe("session binding", () => {
  it("opens only for the session that earned it", () => {
    const marker = signRecoveryMarker(markerSubject(USER, S1), NOW, SECRET);
    expect(verifyRecoveryMarker(marker, markerSubject(USER, S1), SECRET, NOW)).toBe(true);
    expect(verifyRecoveryMarker(marker, markerSubject(USER, S2), SECRET, NOW)).toBe(false);
  });

  it("subjectFromClaims needs both a user and a session id", () => {
    expect(subjectFromClaims({ sub: USER, session_id: S1 })).toBe(markerSubject(USER, S1));
    expect(subjectFromClaims({ sub: USER })).toBeNull();
    expect(subjectFromClaims({ session_id: S1 })).toBeNull();
    expect(subjectFromClaims({ sub: "", session_id: S1 })).toBeNull();
    expect(subjectFromClaims({ sub: USER, session_id: "" })).toBeNull();
    expect(subjectFromClaims({ sub: 1, session_id: S1 })).toBeNull();
    expect(subjectFromClaims(null)).toBeNull();
    expect(subjectFromClaims(undefined)).toBeNull();
  });

  it("a subject never contains the marker's separator", () => {
    expect(markerSubject(USER, S1)).not.toContain(".");
  });
});

describe("sessionIdOfFreshToken", () => {
  it("reads session_id from the token payload", () => {
    expect(sessionIdOfFreshToken(token({ sub: USER, session_id: S1 }))).toBe(S1);
  });

  it.each([
    { value: undefined, why: "no token" },
    { value: "", why: "an empty token" },
    { value: "onlyonepart", why: "no payload segment" },
    { value: "h.!!!notbase64json!!!.s", why: "an unparseable payload" },
    { value: token({ sub: USER }), why: "no session_id" },
    { value: token({ session_id: 42 }), why: "a non-string session_id" },
    { value: token(null), why: "a null payload" },
  ])("returns null for $why", ({ value }) => {
    expect(sessionIdOfFreshToken(value)).toBeNull();
  });
});
