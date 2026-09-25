import { describe, expect, it } from "vitest";
import { safeExternalHref } from "@/lib/safeHref";

describe("safeExternalHref — further bypass attempts", () => {
  it.each([
    "\u0001\u001fjavascript:alert(1)",
    " javascript:alert(1)", // NBSP is not stripped by WHATWG, so this is not a scheme at all
    "javascript://%0aalert(1)",
    "javascript:https://example.com",
    "blob:https://example.com/uuid",
    "file:///etc/passwd",
    "ftp://example.com/",
    "ws://example.com/",
    "about:blank",
    "/relative/path",
    "example.com",
    "",
  ])("drops %j", (url) => {
    expect(safeExternalHref(url)).toBeUndefined();
  });

  it.each([null, undefined, 42, {}])("tolerates non-string runtime data %j without throwing", (v) => {
    expect(() => safeExternalHref(v as unknown as string)).not.toThrow();
    expect(safeExternalHref(v as unknown as string)).toBeUndefined();
  });

  it.each(["HTTPS://EXAMPLE.COM/A", "https://user:pw@example.com/", "http://[::1]:8080/x", "https://例え.jp/"])(
    "keeps legitimate http(s) %j verbatim",
    (url) => {
      expect(safeExternalHref(url)).toBe(url);
    }
  );

  it("whatever it returns, a browser-equivalent parse of it is http(s)", () => {
    const inputs = ["\thttps://ok.example/", " https://ok.example/ ", "https:\\\\ok.example\\x", "https:ok.example"];
    for (const u of inputs) {
      const out = safeExternalHref(u);
      if (out !== undefined) expect(["http:", "https:"]).toContain(new URL(out).protocol);
    }
  });
});
