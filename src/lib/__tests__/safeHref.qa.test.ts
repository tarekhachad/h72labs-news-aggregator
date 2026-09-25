import { describe, expect, it } from "vitest";
import { safeExternalHref } from "@/lib/safeHref";

describe("safeExternalHref — bypass attempts", () => {
  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "JaVaScRiPt:alert(1)",
    "\tjavascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\rscript:alert(1)",
    "j\ta\nv\ra script:alert(1)",
    "  javascript:alert(1)  ",
    "\u0000javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
  ])("drops case/whitespace/control-char variants: %j", (url) => {
    expect(safeExternalHref(url)).toBeUndefined();
  });

  it.each(["//evil.example.com/x", "///evil.example.com", "//evil.example.com:80@x"])(
    "drops protocol-relative %j (no scheme to allow-list)",
    (url) => {
      expect(safeExternalHref(url)).toBeUndefined();
    }
  );

  it.each(["javascript&colon;alert(1)", "java script:alert(1)", "javascript%3Aalert(1)"])(
    "drops entity-ish / encoded-looking strings that aren't valid URLs: %j",
    (url) => {
      expect(safeExternalHref(url)).toBeUndefined();
    }
  );

  it("still keeps a real https URL that merely contains 'javascript' as text", () => {
    expect(safeExternalHref("https://example.com/javascript:not-a-scheme")).toBe(
      "https://example.com/javascript:not-a-scheme"
    );
  });

  it.each(["https://example.com", "http://example.com/path?q=1#frag"])("keeps a normal url %j", (url) => {
    expect(safeExternalHref(url)).toBe(url);
  });
});
