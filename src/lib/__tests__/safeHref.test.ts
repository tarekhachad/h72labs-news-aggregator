import { describe, expect, it } from "vitest";
import { safeExternalHref } from "@/lib/safeHref";

describe("safeExternalHref", () => {
  it.each(["https://www.bbc.co.uk/news/1", "http://example.com/a?b=c"])("keeps %s", (url) => {
    expect(safeExternalHref(url)).toBe(url);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "/relative/path",
    "",
    "not a url",
  ])("drops %j", (url) => {
    expect(safeExternalHref(url)).toBeUndefined();
  });
});
