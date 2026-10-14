import "next/dist/server/node-environment-baseline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCappedText, PanelFetchError } from "../fetchJson";
import { parseTreasuryFeed, fetchTreasuryTenYear } from "../treasury";
import { fetchOilPrices, parseOilPrices } from "../eia";
import { formatYield, formatFxRate, formatOilPrice, formatDay } from "../format";
import { treasuryFeed, xmlResponse, eiaLatest } from "./ratesFixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const stream = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });

describe("fetchCappedText", () => {
  it("rejects an over-cap streamed body that declares no length", async () => {
    const big = new Uint8Array(600);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream([big, big]), { status: 200 })));
    await expect(fetchCappedText("https://x.test/a", { maxBytes: 1000 })).rejects.toBeInstanceOf(PanelFetchError);
  });
  it("rejects early when declared length is over the cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": "5000" } })));
    await expect(fetchCappedText("https://x.test/a", { maxBytes: 1000 })).rejects.toThrow(/over 1000/);
  });
  it("accepts a body of exactly maxBytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a".repeat(1000), { status: 200 })));
    await expect(fetchCappedText("https://x.test/a", { maxBytes: 1000 })).resolves.toHaveLength(1000);
  });
  it("times out a body that stalls after headers, as PanelFetchError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(3));
            init.signal!.addEventListener("abort", () => c.error(init.signal!.reason));
          },
        });
        return new Response(body, { status: 200 });
      })
    );
    await expect(fetchCappedText("https://x.test/a", { maxBytes: 1000, timeoutMs: 50 })).rejects.toBeInstanceOf(
      PanelFetchError
    );
  });
  it("sends redirect:error and the headers, wraps fetch errors, keeps the query out of the message", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", f);
    const err = await fetchCappedText("https://x.test/a?apikey=SECRET", {
      maxBytes: 10,
      headers: { "X-Api-Key": "SECRET" },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PanelFetchError);
    expect(err.message).not.toContain("SECRET");
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("SECRET");
  });
  it("non-OK status is a PanelFetchError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    const err = await fetchCappedText("https://x.test/a", { maxBytes: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(PanelFetchError);
    expect(err.message).toMatch(/403/);
  });
});

describe("treasury parser adversarial", () => {
  it("is fast on pathological bodies", () => {
    const head = treasuryFeed([]).replace("</feed>", "");
    const bodies = [
      head + "<m:properties>".repeat(30) + "<d:NEW_DATE" + " ".repeat(200_000),
      head + "<m:properties><d:NEW_DATE " + "a".repeat(250_000),
      head + "<m:properties>" + "<d:BC_10YEAR>".repeat(20_000) + "</m:properties></feed>",
      head + "<m:properties>" + "<d:NEW_DATE>2026-10-1".repeat(12_000) + "</m:properties></feed>",
      "<feed " + "<".repeat(250_000),
      "   ".repeat(80_000) + "<feed",
      "<?xml " + " ".repeat(250_000),
    ];
    for (const b of bodies) {
      const t = performance.now();
      try {
        parseTreasuryFeed(b);
      } catch (e) {
        expect(e).toBeInstanceOf(PanelFetchError);
      }
      expect(performance.now() - t).toBeLessThan(500);
    }
  });
  it("more than 31 entries rejected; unclosed rejected; null ten-year skipped", () => {
    const many = treasuryFeed(
      Array.from({ length: 32 }, (_, i) => ({ date: "2026-10-01", tenYear: "5.0" + (i % 10) }))
    );
    expect(() => parseTreasuryFeed(many)).toThrow(PanelFetchError);
    expect(() =>
      parseTreasuryFeed(
        treasuryFeed([]).replace("</feed>", "<m:properties><d:NEW_DATE>2026-10-01T00:00:00</d:NEW_DATE></feed>")
      )
    ).toThrow(PanelFetchError);
    const r = parseTreasuryFeed(
      treasuryFeed([
        { date: "2026-10-01", tenYear: "5.10" },
        { date: "2026-10-02", tenYear: null },
      ])
    );
    expect(r).toEqual({ value: 5.1, date: "2026-10-01" });
  });
  it("picks max date regardless of entry order; skips impossible dates", () => {
    const r = parseTreasuryFeed(
      treasuryFeed([
        { date: "2026-10-09", tenYear: "5.30" },
        { date: "2026-10-02", tenYear: "5.00" },
        { date: "2026-02-30", tenYear: "9.99" },
      ])
    );
    expect(r).toEqual({ value: 5.3, date: "2026-10-09" });
  });
  it("empty month returns null; HTML error page throws", () => {
    expect(parseTreasuryFeed(treasuryFeed([]))).toBeNull();
    expect(() => parseTreasuryFeed("<html>blocked</html>")).toThrow(PanelFetchError);
  });
  it("falls back across the January to December boundary", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        return xmlResponse(
          urls.length === 1 ? treasuryFeed([]) : treasuryFeed([{ date: "2025-12-31", tenYear: "4.50" }])
        );
      })
    );
    const r = await fetchTreasuryTenYear(new Date(Date.UTC(2026, 0, 2)));
    expect(r).toEqual({ value: 4.5, date: "2025-12-31" });
    expect(urls[0]).toContain("=202601");
    expect(urls[1]).toContain("=202512");
  });
  it("throws when the current month fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    await expect(fetchTreasuryTenYear(new Date())).rejects.toBeInstanceOf(PanelFetchError);
  });
});

describe("EIA key hygiene", () => {
  const KEY = "SUPERSECRETKEY123";
  it("key never in URL; sent as header; errors do not contain it", async () => {
    vi.stubEnv("EIA_API_KEY", `  ${KEY}  `);
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    const err = await fetchOilPrices().catch((e) => e);
    expect(err).toBeInstanceOf(PanelFetchError);
    expect(String(err.message)).not.toContain(KEY);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe(KEY);
  });
  it("whitespace-only key counts as no key and makes no request", async () => {
    vi.stubEnv("EIA_API_KEY", "   ");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(fetchOilPrices()).rejects.toThrow(PanelFetchError);
    expect(f).not.toHaveBeenCalled();
  });
  it("a network error that echoes the key yields a clean message", async () => {
    vi.stubEnv("EIA_API_KEY", KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`bad header ${KEY}`);
      })
    );
    const err = await fetchOilPrices().catch((e) => e);
    expect(err.message).not.toContain(KEY);
  });
  it("parseOilPrices: one series only; negative WTI; junk strings rejected", () => {
    const body = JSON.parse(JSON.stringify(eiaLatest));
    body.response.data = body.response.data.filter((r: { series: string }) => r.series === "RWTC");
    body.response.data[0].value = "-37.63";
    expect(parseOilPrices(body)).toEqual({ brent: null, wti: { value: -37.63, date: "2026-10-06" } });
    body.response.data.forEach((r: { value: unknown }) => (r.value = "1e3"));
    expect(() => parseOilPrices(body)).toThrow(PanelFetchError);
  });
});

describe("format edge cases", () => {
  it("rounds and signs", () => {
    expect(formatYield(-0.001)).toBe("0.00%");
    expect(formatFxRate(9.75149)).toBe("9.7515");
    expect(formatOilPrice(-37.634)).toBe("−$37.63");
    expect(formatOilPrice(1234.5)).toBe("$1,234.50");
    expect(formatDay("2026-10-06")).toBe("Oct 6, 2026");
    expect(formatDay("2026-13-01")).toBeNull();
  });
});

describe("EIA ordering", () => {
  it("takes the newest day per series even when rows arrive oldest first", () => {
    const body = JSON.parse(JSON.stringify(eiaLatest));
    body.response.data.reverse();
    expect(parseOilPrices(body)).toEqual({
      brent: { value: 125.44, date: "2026-10-06" },
      wti: { value: 96.24, date: "2026-10-06" },
    });
  });
});
