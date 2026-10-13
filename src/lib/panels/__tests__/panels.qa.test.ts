import "next/dist/server/node-environment-baseline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCappedJson, PanelFetchError } from "../fetchJson";
import { fetchWorldBankFacts } from "../worldBank";
import { fetchWikidataFacts, parseWikidataResponse } from "../wikidata";
import { getCountryFacts } from "../countryFacts";
import { formatPopulation, formatUsd, formatPercent } from "../format";
import { jsonResponse, wbCountry, wbIndicator, wbMeta, wdBinding, wdBody } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stream(chunks: (string | Error)[]) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= chunks.length) return c.close();
      const x = chunks[i++];
      if (x instanceof Error) return c.error(x);
      c.enqueue(enc.encode(x));
    },
  });
}

describe("fetchCappedJson edges", () => {
  it("mid-body stream error becomes PanelFetchError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream(['{"a":', new Error("reset")]))));
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: 100 })).rejects.toBeInstanceOf(PanelFetchError);
  });
  it("lying small content-length with big body is still capped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream(["x".repeat(60), "x".repeat(60)]), { headers: { "content-length": "5" } }))
    );
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: 100 })).rejects.toThrow(/over 100/);
  });
  it("garbage content-length is ignored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"a":1}', { headers: { "content-length": "abc" } })));
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: 100 })).resolves.toEqual({ a: 1 });
  });
  it("body exactly at cap passes, one over fails", async () => {
    const body = '{"a":1}';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream([body]))));
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: body.length })).resolves.toEqual({ a: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream([body]))));
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: body.length - 1 })).rejects.toBeInstanceOf(
      PanelFetchError
    );
  });
  it("empty body, HTML 200 and a rejected redirect are all errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("")));
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: 100 })).rejects.toBeInstanceOf(PanelFetchError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>")));
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: 100 })).rejects.toBeInstanceOf(PanelFetchError);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("redirect");
      })
    );
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: 100 })).rejects.toBeInstanceOf(PanelFetchError);
  });
  it("a fetch that hangs forever is cut by the real 4 s timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_r, rej) => {
            init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
          })
      )
    );
    const t = Date.now();
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: 100 })).rejects.toBeInstanceOf(PanelFetchError);
    expect(Date.now() - t).toBeLessThan(5500);
    expect(Date.now() - t).toBeGreaterThanOrEqual(3900);
  }, 8000);
  it("a body that stalls after headers is cut by the same timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            init.signal!.addEventListener("abort", () => c.error(init.signal!.reason));
          },
        });
        return new Response(body);
      })
    );
    const t = Date.now();
    await expect(fetchCappedJson("https://x.test/a", { maxBytes: 100 })).rejects.toBeInstanceOf(PanelFetchError);
    expect(Date.now() - t).toBeLessThan(5500);
  }, 8000);
});

describe("World Bank partial failures throw (never partial data)", () => {
  function run(overrides: Record<string, () => Response>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        for (const k of Object.keys(overrides)) if (url.includes(k)) return overrides[k]();
        if (url.includes("SP.POP")) return jsonResponse(wbIndicator("SP.POP.TOTL", "MA", "2025", 1e7));
        if (url.includes("/indicator/")) return jsonResponse(wbIndicator("X", "MA", "2024", 5));
        return jsonResponse(wbCountry("MA", "Rabat"));
      })
    );
    return fetchWorldBankFacts("MA");
  }
  it("one indicator 503 -> throws", async () => {
    await expect(run({ "NY.GDP": () => jsonResponse({}, { status: 503 }) })).rejects.toBeInstanceOf(PanelFetchError);
  });
  it("one indicator malformed -> throws", async () => {
    await expect(run({ "FP.CPI": () => jsonResponse({ x: 1 }) })).rejects.toBeInstanceOf(PanelFetchError);
  });
  it("date not 4 digits -> throws", async () => {
    await expect(run({ "SP.POP": () => jsonResponse(wbIndicator("a", "MA", "2025Q1", 5)) })).rejects.toBeInstanceOf(
      PanelFetchError
    );
  });
  it("rate-limit style message (other id) -> throws", async () => {
    await expect(
      run({ "NY.GDP": () => jsonResponse([{ message: [{ id: "175", key: "x", value: "y" }] }]) })
    ).rejects.toBeInstanceOf(PanelFetchError);
  });
  it("mixed message ids (120 + other) -> throws", async () => {
    await expect(
      run({ "NY.GDP": () => jsonResponse([{ message: [{ id: "120" }, { id: "175" }] }]) })
    ).rejects.toBeInstanceOf(PanelFetchError);
  });
  it("empty array body -> throws; [meta, []] -> null figure", async () => {
    await expect(run({ "NY.GDP": () => jsonResponse([]) })).rejects.toBeInstanceOf(PanelFetchError);
    const r = await run({ "NY.GDP": () => jsonResponse([wbMeta, []]) });
    expect(r?.gdpUsd).toBeNull();
  });
  it("bad codes are rejected before any fetch", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    for (const c of ["ma", "MAR", "M/", "../", "MA?x=1", ""])
      await expect(fetchWorldBankFacts(c)).rejects.toBeInstanceOf(PanelFetchError);
    await expect(fetchWikidataFacts('MA" . } #')).rejects.toBeInstanceOf(PanelFetchError);
    expect(f).not.toHaveBeenCalled();
  });
  it("capital that is whitespace / over-long is null", async () => {
    expect((await run({ "/MA?": () => jsonResponse(wbCountry("MA", "   ")) }))?.capital).toBeNull();
    expect((await run({ "/MA?": () => jsonResponse(wbCountry("MA", "x".repeat(81))) }))?.capital).toBeNull();
  });
  it("string-typed value is rejected", async () => {
    await expect(
      run({ "SP.POP": () => jsonResponse(wbIndicator("a", "MA", "2025", "5" as unknown as number)) })
    ).rejects.toBeInstanceOf(PanelFetchError);
  });
});

describe("Wikidata parse edges", () => {
  const T = "2026-10-13";
  it("200 rows ok, 201 rows throws", () => {
    const mk = (n: number) =>
      wdBody(Array.from({ length: n }, () => wdBinding({ prop: "currency", value: "Q1", label: "A" })));
    expect(parseWikidataResponse(mk(200), T)).not.toBeNull();
    expect(() => parseWikidataResponse(mk(201), T)).toThrow(PanelFetchError);
  });
  it("deprecated rows ignored; all-deprecated -> null", () => {
    const b = wdBody([
      {
        ...wdBinding({ prop: "currency", value: "Q1", label: "A" }),
        rank: { type: "uri", value: "http://wikiba.se/ontology#DeprecatedRank" },
      },
    ]);
    expect(parseWikidataResponse(b, T)).toBeNull();
  });
  it("preferred without label hides a labelled normal value (shows nothing, not wrong)", () => {
    const f = parseWikidataResponse(
      wdBody([
        wdBinding({ prop: "headOfState", value: "Q1", label: null, rank: "Preferred" }),
        wdBinding({ prop: "headOfState", value: "Q2", label: "Old", rank: "Normal" }),
      ]),
      T
    )!;
    expect(f.headOfState).toEqual([]);
  });
  it("3 values -> none; 2 -> both; preferred narrows 3 to 1", () => {
    const three = ["Q1", "Q2", "Q3"].map((q) => wdBinding({ prop: "headOfState", value: q, label: q, rank: "Normal" }));
    expect(parseWikidataResponse(wdBody(three), T)!.headOfState).toEqual([]);
    expect(parseWikidataResponse(wdBody(three.slice(0, 2)), T)!.headOfState).toHaveLength(2);
    const pref = [wdBinding({ prop: "headOfState", value: "Q9", label: "P", rank: "Preferred" }), ...three];
    expect(parseWikidataResponse(wdBody(pref), T)!.headOfState).toEqual([{ id: "Q9", label: "P" }]);
  });
  it("HTML label kept verbatim as text; whitespace label dropped", () => {
    const f = parseWikidataResponse(
      wdBody([
        wdBinding({ prop: "currency", value: "Q1", label: "<img src=x onerror=alert(1)>" }),
        wdBinding({ prop: "headOfState", value: "Q2", label: "   " }),
      ]),
      T
    )!;
    expect(f.currency[0].label).toBe("<img src=x onerror=alert(1)>");
    expect(f.headOfState).toEqual([]);
  });
  it("malicious Q-ids / entity uris rejected", () => {
    const b = wdBody([wdBinding({ prop: "currency", value: 'Q1"><script>', label: "A" })]);
    expect(parseWikidataResponse(b, T)).toBeNull();
    const b2 = wdBody([
      { ...wdBinding({ prop: "currency", value: "Q1", label: "A" }), c: { type: "uri", value: "http://evil/entity/Q1" } },
    ]);
    expect(parseWikidataResponse(b2, T)).toBeNull();
  });
  it("wrong shapes throw", () => {
    for (const b of [null, [], {}, { results: {} }, { results: { bindings: [{}] } }, { results: { bindings: "x" } }]) {
      expect(() => parseWikidataResponse(b, T)).toThrow(PanelFetchError);
    }
  });
  it("empty bindings -> null", () => {
    expect(parseWikidataResponse(wdBody([]), T)).toBeNull();
  });
  it("most linked entity wins", () => {
    const f = parseWikidataResponse(
      wdBody([
        wdBinding({ entity: "Q2", links: 5, prop: "currency", value: "Q6", label: "Small" }),
        wdBinding({ entity: "Q1", links: 500, prop: "currency", value: "Q5", label: "Big" }),
      ]),
      T
    )!;
    expect(f.entity).toBe("Q1");
    expect(f.currency[0].label).toBe("Big");
  });
});

describe("getCountryFacts never throws", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  it("with no incremental cache and all fetches failing, resolves null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("down");
      })
    );
    await expect(getCountryFacts("Morocco")).resolves.toBeNull();
  });
  it("unknown names resolve null, incl. prototype keys", async () => {
    for (const n of ["constructor", "__proto__", "toString", "", "Atlantis"])
      await expect(getCountryFacts(n)).resolves.toBeNull();
  });
});

describe("format edges", () => {
  it("boundaries", () => {
    expect(formatPopulation({ value: 999_960, year: 2024 })).toBe("1.0 million (2024)");
    expect(formatPopulation({ value: 999_949, year: 2024 })).toBe("1,000,000 (2024)");
    expect(formatPopulation({ value: 55_300_000, year: 2024 })).toBe("55.3 million (2024)");
    expect(formatUsd({ value: 108_000_000_000, year: 2024 })).toBe("$108.0 bn (2024)");
    expect(formatUsd({ value: 999_990_000, year: 2024 })).toBe("$1.0 bn (2024)");
    expect(formatPercent({ value: 4.5, year: 2024 })).toBe("4.5% (2024)");
    expect(formatPercent({ value: -0.04, year: 2024 })).toBe("0.0% (2024)");
    expect(formatPercent({ value: 0, year: 2024 })).toBe("0.0% (2024)");
  });
});
