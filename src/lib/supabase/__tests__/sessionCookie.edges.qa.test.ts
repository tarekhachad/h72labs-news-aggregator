// QA round 1: sessionCookieMatcher against the names @supabase/ssr really
// writes, for URL shapes the shipped tests do not cover.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import { sessionCookieMatcher } from "@/lib/supabase/sessionCookie";

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

const storageKeyFor = (url: string) =>
  (createServerClient(url, "sb_publishable_dummy", { cookies: { getAll: () => [], setAll: () => {} } }).auth as unknown as { storageKey: string }).storageKey;

describe("agrees with @supabase/ssr's storage key for more URL shapes", () => {
  it.each([
    "http://[::1]:54321",
    "https://user:pass@abcdefghijklmnopqrst.supabase.co",
    "https://abcdefghijklmnopqrst.supabase.co:443/rest/v1/?x=1#frag",
    "HTTPS://ABCDEFGHIJKLMNOPQRST.SUPABASE.CO",
    "http://localhost",
    "https://api.example.com",
    "https://xn--bcher-kva.example",
  ])("%s", (url) => {
    const key = storageKeyFor(url);
    const isOurs = sessionCookieMatcher(url);
    expect(isOurs(key)).toBe(true);
    expect(isOurs(`${key}.0`)).toBe(true);
    expect(isOurs(`${key}-code-verifier`)).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("the missing-URL log line", () => {
  it("is one line per matcher built, with no URL value or secret in it", () => {
    vi.stubEnv("SUPABASE_URL", "not a url");
    sessionCookieMatcher();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).not.toContain("not a url");
  });

  it("a matcher built from a usable URL logs nothing however many names it is asked about", () => {
    const isOurs = sessionCookieMatcher("http://127.0.0.1:54321");
    for (let i = 0; i < 50; i++) isOurs(`x${i}`);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
