// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RatesStripData } from "@/lib/panels/rates";
import { RatesStrip } from "../RatesStrip";

const ALL: RatesStripData = {
  tenYear: { value: 5.21, date: "2026-10-13" },
  fx: { eurUsd: { value: 1.1199, date: "2026-10-14" }, usdMad: { value: 9.7515, date: "2026-10-13" } },
  oil: { brent: { value: 125.44, date: "2026-10-06" }, wti: { value: 96.24, date: "2026-10-06" } },
};

function render(data: RatesStripData) {
  const html = renderToStaticMarkup(<RatesStrip data={data} />);
  const host = document.createElement("div");
  host.innerHTML = html;
  const rows = [...host.querySelectorAll("dl > div")].map((row) => [...row.children].map((cell) => cell.textContent));
  const credits = [...host.querySelectorAll("li")].map((li) => li.textContent);
  const links = [...host.querySelectorAll("li a")].map((a) => a.getAttribute("href"));
  return { html, host, rows, credits, links };
}

describe("RatesStrip", () => {
  it("opens with a rule line and a kicker, inside a labelled band", () => {
    const { host } = render(ALL);
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("Rates & commodities");
    const rule = host.querySelector("section > div");
    expect(rule?.className).toContain("border-t");
    expect(rule?.getAttribute("style")).toContain("var(--color-rule)");
    const kicker = host.querySelector("h2");
    expect(kicker?.textContent).toBe("Rates & commodities");
    expect(kicker?.className).toContain("uppercase");
    expect(kicker?.className).toContain("tracking-[0.12em]");
  });

  it("shows each value at its precision with its own day", () => {
    expect(render(ALL).rows).toEqual([
      ["US 10-year Treasury yield", "5.21%", "as of Oct 13, 2026"],
      ["EUR/USD", "1.1199", "as of Oct 14, 2026"],
      ["USD/MAD", "9.7515", "as of Oct 13, 2026"],
      ["Brent crude", "$125.44 a barrel", "as of Oct 6, 2026"],
      ["WTI crude", "$96.24 a barrel", "as of Oct 6, 2026"],
    ]);
  });

  it("credits every source that supplied a value, each linked to its source page", () => {
    const { credits, links, host } = render(ALL);
    expect(credits).toEqual([
      "Treasury: U.S. Department of the Treasury",
      "Exchange rates: Frankfurter",
      "Oil: Source: U.S. Energy Information Administration",
    ]);
    expect(links).toEqual([
      "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve",
      "https://frankfurter.dev/",
      "https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.htm",
    ]);
    for (const a of host.querySelectorAll("a")) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows only what came back, and credits only those sources", () => {
    const { rows, credits } = render({ tenYear: ALL.tenYear, fx: null, oil: null });
    expect(rows.map((r) => r[0])).toEqual(["US 10-year Treasury yield"]);
    expect(credits).toEqual(["Treasury: U.S. Department of the Treasury"]);

    const oneOil = render({ tenYear: null, fx: null, oil: { brent: null, wti: ALL.oil!.wti } });
    expect(oneOil.rows.map((r) => r[0])).toEqual(["WTI crude"]);
    expect(oneOil.credits).toEqual(["Oil: Source: U.S. Energy Information Administration"]);
  });

  it("renders nothing when there is nothing to show", () => {
    expect(render({ tenYear: null, fx: null, oil: { brent: null, wti: null } }).html).toBe("");
  });

  it("leaves out a value whose day does not parse, rather than showing it undated", () => {
    const { rows, credits } = render({ ...ALL, tenYear: { value: 5.21, date: "2026-13-01" } });
    expect(rows.map((r) => r[0])).not.toContain("US 10-year Treasury yield");
    expect(credits).not.toContain("Treasury: U.S. Department of the Treasury");
  });

  it("colours nothing red or green and draws no box: levels, not moves", () => {
    const { html } = render(ALL);
    expect(html).not.toMatch(/red|green|accent|destructive|shadow|rounded|border-x|border-b\b/i);
    expect(html).not.toMatch(/[▲▼↑↓]/);
  });

  it("wraps to two columns at phone width rather than scrolling sideways", () => {
    const { host } = render(ALL);
    const grid = host.querySelector("dl")!;
    expect(grid.className).toContain("grid-cols-2");
    expect(grid.className).not.toMatch(/overflow-x|whitespace-nowrap/);
    expect(host.querySelector("ul")?.className).toContain("flex-wrap");
  });
});
