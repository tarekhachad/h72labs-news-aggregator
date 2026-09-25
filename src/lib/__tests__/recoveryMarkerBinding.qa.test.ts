import { describe, expect, it } from "vitest";
import {
  markerSubject,
  sessionIdOfFreshToken,
  signRecoveryMarker,
  subjectFromClaims,
  verifyRecoveryMarker,
} from "@/lib/recoveryMarker";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const S_OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S_NEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = "k".repeat(44);
const now = 1_800_000_000;

const tok = (payload: unknown, enc: BufferEncoding = "base64url") =>
  `hdr.${Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString(enc)}.sig`;

describe("session binding — verifyRecoveryMarker with subjectFromClaims", () => {
  const marker = signRecoveryMarker(markerSubject(USER, S_OLD), now, SECRET);

  it("accepts the exact session it was minted for", () => {
    expect(verifyRecoveryMarker(marker, subjectFromClaims({ sub: USER, session_id: S_OLD }), SECRET, now)).toBe(true);
  });

  it("refuses the right user on a different (newer) session", () => {
    expect(verifyRecoveryMarker(marker, subjectFromClaims({ sub: USER, session_id: S_NEW }), SECRET, now)).toBe(false);
  });

  it("refuses a different user carrying the same session id", () => {
    expect(verifyRecoveryMarker(marker, subjectFromClaims({ sub: OTHER_USER, session_id: S_OLD }), SECRET, now)).toBe(false);
  });

  it("refuses an old-format (user-only) marker even for the right user and session", () => {
    const legacy = signRecoveryMarker(USER, now, SECRET);
    expect(verifyRecoveryMarker(legacy, subjectFromClaims({ sub: USER, session_id: S_OLD }), SECRET, now)).toBe(false);
  });

  it.each([
    ["missing session_id", { sub: USER }],
    ["empty session_id", { sub: USER, session_id: "" }],
    ["null session_id", { sub: USER, session_id: null }],
    ["numeric session_id", { sub: USER, session_id: 42 }],
    ["array session_id", { sub: USER, session_id: [S_OLD] }],
    ["missing sub", { session_id: S_OLD }],
    ["empty sub", { sub: "", session_id: S_OLD }],
    ["null claims", null],
    ["undefined claims", undefined],
    ["string claims", "sub"],
  ])("subjectFromClaims returns null for %s, and that never verifies", (_label, claims) => {
    const subject = subjectFromClaims(claims);
    expect(subject).toBeNull();
    expect(verifyRecoveryMarker(marker, subject, SECRET, now)).toBe(false);
  });

  it("a marker minted for an empty session id does not verify for claims with no session id", () => {
    // markerSubject(USER, "") => `${USER}:` — an attacker cannot reach this subject from claims.
    const emptySessionMarker = signRecoveryMarker(markerSubject(USER, ""), now, SECRET);
    expect(verifyRecoveryMarker(emptySessionMarker, subjectFromClaims({ sub: USER }), SECRET, now)).toBe(false);
    expect(verifyRecoveryMarker(emptySessionMarker, subjectFromClaims({ sub: USER, session_id: "" }), SECRET, now)).toBe(false);
  });

  it("cannot be re-bound by editing the subject in the cookie (MAC covers the session)", () => {
    const [, issued, sig] = marker.split(".");
    const forged = `${markerSubject(USER, S_NEW)}.${issued}.${sig}`;
    expect(verifyRecoveryMarker(forged, subjectFromClaims({ sub: USER, session_id: S_NEW }), SECRET, now)).toBe(false);
  });

  it("a session id containing '.' fails closed (4-part marker)", () => {
    const dotted = signRecoveryMarker(markerSubject(USER, "a.b"), now, SECRET);
    expect(verifyRecoveryMarker(dotted, subjectFromClaims({ sub: USER, session_id: "a.b" }), SECRET, now)).toBe(false);
  });

  it("still enforces the window after binding (1h + 1s is refused)", () => {
    expect(
      verifyRecoveryMarker(marker, subjectFromClaims({ sub: USER, session_id: S_OLD }), SECRET, now + 3601)
    ).toBe(false);
  });
});

describe("sessionIdOfFreshToken — crafted tokens", () => {
  it("reads session_id from a well-formed payload", () => {
    expect(sessionIdOfFreshToken(tok({ sub: USER, session_id: S_OLD }))).toBe(S_OLD);
  });

  it.each([
    ["undefined", undefined],
    ["empty string", ""],
    ["no dots", "abc"],
    ["empty payload segment", "hdr..sig"],
  ])("returns null for %s", (_l, t) => {
    expect(sessionIdOfFreshToken(t as string | undefined)).toBeNull();
  });

  it.each([
    ["non-JSON payload", tok("not json")],
    ["JSON null", tok("null")],
    ["JSON array", tok([S_OLD])],
    ["JSON number", tok("5")],
    ["numeric session_id", tok({ session_id: 5 })],
    ["object session_id", tok({ session_id: { id: S_OLD } })],
    ["no session_id", tok({ sub: USER })],
    ["garbage bytes", "hdr.%%%%.sig"],
  ])("returns null for %s", (_l, t) => {
    expect(sessionIdOfFreshToken(t)).toBeNull();
  });

  it("returns '' for an empty session_id, which the route treats as falsy (no marker)", () => {
    expect(sessionIdOfFreshToken(tok({ session_id: "" }))).toBe("");
  });

  it("tolerates standard base64 with padding (Node's base64url decoder is lenient)", () => {
    expect(sessionIdOfFreshToken(tok({ session_id: S_OLD }, "base64"))).toBe(S_OLD);
  });
});
