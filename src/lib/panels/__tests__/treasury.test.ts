import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelFetchError } from "../fetchJson";
import { feedMonth, fetchTreasuryTenYear, parseTreasuryFeed, TREASURY_TIMEOUT_MS } from "../treasury";
import { treasuryFeed, treasuryOctober, xmlResponse } from "./ratesFixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseTreasuryFeed", () => {
  it("reads the latest day's 10-year yield", () => {
    expect(parseTreasuryFeed(treasuryOctober)).toEqual({ value: 5.21, date: "2026-10-13" });
  });

  it("picks the latest day, not the last entry", () => {
    const shuffled = treasuryFeed([
      { date: "2026-10-13", tenYear: "5.21" },
      { date: "2026-10-01", tenYear: "5.24" },
    ]);
    expect(parseTreasuryFeed(shuffled)).toEqual({ value: 5.21, date: "2026-10-13" });
  });

  it("skips a day whose 10-year value is null, and a day that is not a real date", () => {
    const xml = treasuryFeed([
      { date: "2026-10-01", tenYear: "5.24" },
      { date: "2026-10-13", tenYear: null },
      { date: "2026-02-30", tenYear: "9.99" },
    ]);
    expect(parseTreasuryFeed(xml)).toEqual({ value: 5.24, date: "2026-10-01" });
  });

  it("answers null for a month with no rows yet", () => {
    expect(parseTreasuryFeed(treasuryFeed([]))).toBeNull();
  });

  it.each([
    ["an HTML error page", "<!DOCTYPE html><html><body>Service unavailable</body></html>"],
    ["an empty body", ""],
    ["another Atom feed", treasuryOctober.replace("DailyTreasuryYieldCurveRateData</title>", "Other</title>")],
  ])("throws on %s", (_name, xml) => {
    expect(() => parseTreasuryFeed(xml)).toThrow(PanelFetchError);
  });

  it("throws on more entries than a month has, and on an unclosed entry", () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({ date: "2026-10-01", tenYear: String(4 + i / 100) }));
    expect(() => parseTreasuryFeed(treasuryFeed(rows))).toThrow(/more entries/);
    const unclosed = treasuryOctober.replace(/<\/m:properties>\s*<\/content>\s*<\/entry>\s*<\/feed>$/, "");
    expect(() => parseTreasuryFeed(unclosed)).toThrow(/unclosed/);
  });

  it("stays fast on a capped-size entry full of tags that never close", () => {
    const head = treasuryFeed([]).replace("</feed>", "");
    const hostile = `${head}<m:properties>${"<d:NEW_DATE <d:BC_10YEAR ".repeat(10_000)}</m:properties></feed>`;
    expect(hostile.length).toBeGreaterThan(250_000);
    const started = performance.now();
    expect(parseTreasuryFeed(hostile)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("feedMonth", () => {
  it("names the UTC month the feed filters on", () => {
    expect(feedMonth(new Date("2026-10-13T12:00:00Z"))).toBe("202610");
    expect(feedMonth(new Date("2027-01-01T00:30:00Z"))).toBe("202701");
  });
});

describe("fetchTreasuryTenYear", () => {
  function stubFeeds(byMonth: Record<string, string | Response>) {
    const fetchMock = vi.fn(async (url: string) => {
      const month = new URL(url).searchParams.get("field_tdr_date_value_month")!;
      const body = byMonth[month];
      if (body === undefined) throw new Error(`unexpected month ${month}`);
      return typeof body === "string" ? xmlResponse(body) : body;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reads the current month's feed, with the slow-upstream timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFeeds({ "202610": treasuryOctober });
    await expect(fetchTreasuryTenYear(new Date("2026-10-14T03:00:00Z"))).resolves.toEqual({
      value: 5.21,
      date: "2026-10-13",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.host).toBe("home.treasury.gov");
    expect(url.searchParams.get("data")).toBe("daily_treasury_yield_curve");
    expect(timeout).toHaveBeenCalledWith(TREASURY_TIMEOUT_MS);
  });

  it("falls back to the previous month early in a month, across a year end", async () => {
    const fetchMock = stubFeeds({
      "202701": treasuryFeed([]),
      "202612": treasuryFeed([{ date: "2026-12-31", tenYear: "4.98" }]),
    });
    await expect(fetchTreasuryTenYear(new Date("2027-01-01T09:00:00Z"))).resolves.toEqual({
      value: 4.98,
      date: "2026-12-31",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when both months are empty, so nothing is cached", async () => {
    stubFeeds({ "202610": treasuryFeed([]), "202609": treasuryFeed([]) });
    await expect(fetchTreasuryTenYear(new Date("2026-10-01T09:00:00Z"))).rejects.toBeInstanceOf(PanelFetchError);
  });

  it("throws on an HTTP error without trying the previous month", async () => {
    const fetchMock = stubFeeds({ "202610": new Response("busy", { status: 503 }) });
    await expect(fetchTreasuryTenYear(new Date("2026-10-13T12:00:00Z"))).rejects.toThrow(/status 503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
