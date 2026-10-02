import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";
import { EXPIRED_SESSION_COOKIE, sessionCookieMatcher } from "@/lib/supabase/sessionCookie";

const PROD_LIKE = "https://abcdefghijklmnopqrst.supabase.co";
const OURS = "sb-abcdefghijklmnopqrst-auth-token";

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("sessionCookieMatcher", () => {
  it("matches this project's session cookie and each of its chunks", () => {
    const isOurs = sessionCookieMatcher(PROD_LIKE);
    expect(isOurs(OURS)).toBe(true);
    for (const i of [0, 1, 2, 10]) expect(isOurs(`${OURS}.${i}`)).toBe(true);
  });

  it("does not match another project's session cookie, whole or chunked", () => {
    const isOurs = sessionCookieMatcher(PROD_LIKE);
    for (const name of ["sb-other-auth-token", "sb-other-auth-token.0", "sb-abcdefghijklmnopqrs-auth-token", "sb-abcdefghijklmnopqrstu-auth-token"]) {
      expect(isOurs(name)).toBe(false);
    }
  });

  it("does not match this project's other cookies or near-misses of the name", () => {
    const isOurs = sessionCookieMatcher(PROD_LIKE);
    for (const name of [
      `${OURS}-code-verifier`,
      `${OURS}-user`,
      `${OURS}X`,
      `${OURS}.`,
      `${OURS}.x`,
      `${OURS}.1a`,
      `${OURS}.-1`,
      `${OURS}.1.2`,
      `x${OURS}`,
      "theme",
    ]) {
      expect(isOurs(name)).toBe(false);
    }
  });

  it("takes the ref from the hostname's first label, whatever the port, path, case or trailing slash", () => {
    expect(sessionCookieMatcher("http://127.0.0.1:54321")("sb-127-auth-token")).toBe(true);
    expect(sessionCookieMatcher(`${PROD_LIKE}/`)(OURS)).toBe(true);
    expect(sessionCookieMatcher(`  ${PROD_LIKE}  `)(OURS)).toBe(true);
    expect(sessionCookieMatcher("https://MyRef.supabase.co")("sb-myref-auth-token")).toBe(true);
    expect(sessionCookieMatcher("http://localhost:54321/rest")("sb-localhost-auth-token")).toBe(true);
  });

  // The name must be the one @supabase/ssr actually writes, or a clear misses it.
  it.each([PROD_LIKE, "http://127.0.0.1:54321", "https://MyRef.supabase.co/"])("agrees with the storage key @supabase/ssr uses for %s", (url) => {
    const client = createServerClient(url, "sb_publishable_dummy", { cookies: { getAll: () => [], setAll: () => {} } });
    const storageKey = (client.auth as unknown as { storageKey: string }).storageKey;
    expect(sessionCookieMatcher(url)(storageKey)).toBe(true);
  });

  it("reads SUPABASE_URL when no URL is passed", () => {
    vi.stubEnv("SUPABASE_URL", PROD_LIKE);
    expect(sessionCookieMatcher()(OURS)).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["no scheme", "abcdefghijklmnopqrst.supabase.co"],
    ["not http", "ftp://abcdefghijklmnopqrst.supabase.co"],
    ["malformed", "https://"],
  ])("matches nothing, and says so, when SUPABASE_URL is %s", (_label, url) => {
    vi.stubEnv("SUPABASE_URL", url);
    const isOurs = sessionCookieMatcher();
    for (const name of [OURS, `${OURS}.0`, "sb-127-auth-token", "sb--auth-token", "sb-undefined-auth-token"]) {
      expect(isOurs(name)).toBe(false);
    }
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[sessionCookie]"));
  });

  it("a console that throws while reporting the missing URL does not throw out of the matcher", () => {
    errSpy.mockImplementation(() => {
      throw new Error("stdout closed");
    });
    expect(() => sessionCookieMatcher("")).not.toThrow();
  });
});

describe("EXPIRED_SESSION_COOKIE", () => {
  const expiresInPast = (line: string) => {
    const at = /;\s*expires=([^;]+)/i.exec(line)?.[1];
    return at !== undefined && new Date(at).getTime() <= Date.now();
  };

  it("still expires the cookie after Next re-parses the line, as it does when merging a route handler's cookies", () => {
    const first = new ResponseCookies(new Headers());
    first.set(OURS, "", EXPIRED_SESSION_COOKIE);
    const headers = new Headers({ "set-cookie": first.toString() });
    const reparsed = new ResponseCookies(headers);
    reparsed.set(reparsed.get(OURS)!);
    const [line] = headers.getSetCookie();
    expect(line.startsWith(`${OURS}=;`)).toBe(true);
    expect(expiresInPast(line)).toBe(true);
    expect(line).toMatch(/;\s*path=\/(;|$)/i);
  });
});
