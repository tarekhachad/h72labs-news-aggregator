import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RatesStrip } from "../RatesStrip";

const render = (data: Parameters<typeof RatesStrip>[0]["data"]) => renderToStaticMarkup(<RatesStrip data={data} />);

describe("RatesStrip credits and dates", () => {
  it("fx only: only the Frankfurter credit, each value has its own as-of date", () => {
    const html = render({
      tenYear: null,
      oil: null,
      fx: { eurUsd: { value: 1.1, date: "2026-10-13" }, usdMad: { value: 9.7, date: "2026-10-12" } },
    });
    expect(html).toContain("1.1000");
    expect(html).toContain("as of Oct 13, 2026");
    expect(html).toContain("as of Oct 12, 2026");
    expect(html).toContain("Exchange rates:");
    expect(html).not.toContain("Treasury:");
    expect(html).not.toContain("Energy Information");
    expect(html).not.toMatch(/red|green|▲|▼|↑|↓/i);
  });
  it("oil with only WTI credits EIA; with a bad date shows nothing and no credit", () => {
    const html = render({
      tenYear: { value: 4.2, date: "2026-10-13" },
      fx: null,
      oil: { brent: { value: 90, date: "garbage" }, wti: { value: 80, date: "2026-10-06" } },
    });
    expect(html).toContain("WTI crude");
    expect(html).not.toContain("Brent crude");
    expect(html).toContain("Oil: Source:");
    const none = render({ tenYear: null, fx: null, oil: { brent: { value: 1, date: "bad" }, wti: null } });
    expect(none).toBe("");
  });
  it("kicker is spaced caps and credits link out safely", () => {
    const html = render({ tenYear: { value: 4.2, date: "2026-10-13" }, fx: null, oil: null });
    expect(html).toContain("uppercase");
    expect(html).toContain("tracking-");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("4.20%");
    expect(html).not.toContain("<section class=\"rounded");
  });
});
