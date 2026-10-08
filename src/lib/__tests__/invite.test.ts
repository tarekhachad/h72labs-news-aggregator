import { describe, expect, it } from "vitest";
import {
  INVITE_TOKEN_PATTERN,
  INVITE_TTL_DAYS,
  SIGNUP_ERROR_MESSAGES,
  buildInviteLink,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  isSignupErrorCode,
  parseInviteArgs,
  signupErrorCode,
  wellFormedEmail,
} from "@/lib/invite";

describe("generateInviteToken", () => {
  it("produces 43-character base64url tokens that the signup path accepts", () => {
    for (let i = 0; i < 200; i++) {
      const token = generateInviteToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(INVITE_TOKEN_PATTERN);
    }
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 500 }, generateInviteToken));
    expect(tokens.size).toBe(500);
  });
});

describe("hashInviteToken", () => {
  // Postgres: select encode(sha256(convert_to('abc', 'UTF8')), 'hex');
  it("matches the standard sha256 vector as lowercase hex, the hook's format", () => {
    expect(hashInviteToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("INVITE_TOKEN_PATTERN", () => {
  it.each([
    ["too short", "a".repeat(42)],
    ["too long", "a".repeat(44)],
    ["standard base64 characters", "+".repeat(43)],
    ["padding", `${"a".repeat(42)}=`],
    ["empty", ""],
  ])("rejects %s", (_, value) => {
    expect(INVITE_TOKEN_PATTERN.test(value)).toBe(false);
  });
});

describe("buildInviteLink", () => {
  it("points at /signup with the token as the invite parameter and the invitee's email", () => {
    const token = generateInviteToken();
    const link = new URL(buildInviteLink("https://news.h72labs.com", token, "reader@example.com"));
    expect(link.origin).toBe("https://news.h72labs.com");
    expect(link.pathname).toBe("/signup");
    expect(link.searchParams.get("invite")).toBe(token);
    expect(link.searchParams.get("email")).toBe("reader@example.com");
  });

  it("ignores a trailing slash or path on the base URL", () => {
    expect(buildInviteLink("http://localhost:3000/", "x", "a@b.co")).toBe(
      "http://localhost:3000/signup?invite=x&email=a%40b.co"
    );
  });

  it("encodes an address with + so it survives the query string", () => {
    const link = new URL(buildInviteLink("https://news.h72labs.com", "x", "reader+news@example.com"));
    expect(link.search).toContain("reader%2Bnews%40example.com");
    expect(link.searchParams.get("email")).toBe("reader+news@example.com");
  });

  it("round-trips through what parseInviteArgs produces and the signup page accepts", () => {
    const parsed = parseInviteArgs(["Reader", "  Reader.Name@Example.COM "]);
    if (!parsed.ok) throw new Error(parsed.message);
    const link = new URL(buildInviteLink("https://news.h72labs.com", generateInviteToken(), parsed.args.email));
    expect(wellFormedEmail(link.searchParams.get("email"))).toBe("reader.name@example.com");
  });
});

describe("wellFormedEmail", () => {
  it.each([
    ["a plain address", "reader@example.com", "reader@example.com"],
    ["a plus address", "reader+pna@example.com", "reader+pna@example.com"],
    ["mixed case, lowercased the way Auth stores it", "Reader@Example.COM", "reader@example.com"],
  ])("accepts %s", (_, value, expected) => {
    expect(wellFormedEmail(value)).toBe(expected);
  });

  it.each([
    ["undefined", undefined],
    ["null (a missing form field)", null],
    ["a repeated query key (an array)", ["a@b.co", "c@d.co"]],
    ["a File-like object", { name: "a@b.co" }],
    ["empty", ""],
    ["no @", "reader.example.com"],
    ["markup", "<script>alert(1)</script>@example.com"],
    ["quotes and angle brackets", '"x"<a@b.co>'],
    ["surrounding whitespace", " reader@example.com "],
    ["an embedded newline", "reader@example.com\nBcc: x@y.co"],
    ["longer than 254 characters", `${"a".repeat(64)}@${"b".repeat(186)}.com`],
  ])("rejects %s", (_, value) => {
    expect(wellFormedEmail(value)).toBeNull();
  });
});

describe("inviteExpiry", () => {
  it(`is exactly ${INVITE_TTL_DAYS} days later`, () => {
    const now = new Date("2026-09-16T12:00:00Z");
    expect(inviteExpiry(now).toISOString()).toBe("2026-09-23T12:00:00.000Z");
  });
});

describe("parseInviteArgs", () => {
  it("lowercases and trims the email", () => {
    expect(parseInviteArgs(["Ahmed", "  Ahmed.X@Gmail.com "])).toEqual({
      ok: true,
      args: { label: "Ahmed", email: "ahmed.x@gmail.com" },
    });
  });

  it.each([
    ["no arguments", []],
    ["a missing email", ["Ahmed"]],
    ["an extra argument", ["Ahmed", "a@b.com", "extra"]],
    ["a blank label", ["   ", "a@b.com"]],
    ["an invalid email", ["Ahmed", "not-an-email"]],
  ])("rejects %s", (_, argv) => {
    expect(parseInviteArgs(argv).ok).toBe(false);
  });
});

describe("signupErrorCode", () => {
  it.each(["invite_required", "invite_invalid", "invite_email_mismatch"])(
    "passes the hook's %s through",
    (code) => {
      expect(signupErrorCode(code)).toBe(code);
    }
  );

  it.each([
    "User already registered",
    "Signups not allowed for this instance",
    "weak_password",
    "",
  ])("collapses anything else (%j) to signup_failed", (message) => {
    expect(signupErrorCode(message)).toBe("signup_failed");
  });
});

describe("isSignupErrorCode", () => {
  it("accepts every defined code", () => {
    for (const code of Object.keys(SIGNUP_ERROR_MESSAGES)) {
      expect(isSignupErrorCode(code)).toBe(true);
    }
  });

  it.each([undefined, "", "toString", "__proto__", "<script>"])("rejects %j", (value) => {
    expect(isSignupErrorCode(value)).toBe(false);
  });
});
