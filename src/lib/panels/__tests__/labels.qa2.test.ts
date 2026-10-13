import "next/dist/server/node-environment-baseline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWikidataResponse, fetchWikidataFacts } from "../wikidata";
import { PanelFetchError } from "../fetchJson";
import { getCountryFacts } from "../countryFacts";
import { jsonResponse, wbCountry, wbIndicator, wdBinding, wdBody, wdMorocco } from "./fixtures";

const DAY = "2026-10-13";
const untagged = (prop: "currency" | "headOfState" | "headOfGovernment", value: string, extra: object = {}) =>
  wdBinding({ prop, value, label: null, ...extra });

describe("no-English-labels rule: healthy answers must not throw", () => {
  it("a lone labelled row among unlabelled rows is enough", () => {
    const r = parseWikidataResponse(
      wdBody([untagged("currency", "Q1"), wdBinding({ prop: "headOfState", value: "Q2", label: "Leader" })]),
      DAY
    );
    expect(r?.headOfState).toEqual([{ id: "Q2", label: "Leader" }]);
    expect(r?.currency).toEqual([]);
  });
  it("a labelled row on a different (non-chosen) entity still counts as a working label service", () => {
    const r = parseWikidataResponse(
      wdBody([
        untagged("currency", "Q1", { entity: "Q10", links: 500 }),
        wdBinding({ entity: "Q20", links: 5, prop: "currency", value: "Q3", label: "Other" }),
      ]),
      DAY
    );
    expect(r?.entity).toBe("Q10");
    expect(r?.currency).toEqual([]);
  });
  it("tagged but over-long label counts as labelled (no throw), fact dropped", () => {
    const r = parseWikidataResponse(wdBody([wdBinding({ prop: "currency", value: "Q1", label: "x".repeat(101) })]), DAY);
    expect(r?.currency).toEqual([]);
  });
  it("tagged but blank label counts as labelled (no throw)", () => {
    const r = parseWikidataResponse(wdBody([wdBinding({ prop: "currency", value: "Q1", label: "   " })]), DAY);
    expect(r?.currency).toEqual([]);
  });
  it("a non-en tag (e.g. mul) still counts as labelled", () => {
    const row = wdBinding({ prop: "currency", value: "Q1", label: "Euro" });
    (row.valueLabel as Record<string, string>)["xml:lang"] = "mul";
    expect(parseWikidataResponse(wdBody([row]), DAY)?.currency).toEqual([{ id: "Q1", label: "Euro" }]);
  });
  it("rows that toRow discards (blank node / bad rank) do not count toward the all-unlabelled check", () => {
    const blank = wdBinding({ prop: "headOfState", value: "_:b", valueType: "bnode" });
    expect(parseWikidataResponse(wdBody([blank]), DAY)).toBeNull();
    const deprecated = wdBinding({ prop: "currency", value: "Q1", label: null });
    (deprecated.rank as { value: string }).value = "http://wikiba.se/ontology#DeprecatedRank";
    expect(
      parseWikidataResponse(wdBody([deprecated, wdBinding({ prop: "headOfState", value: "Q2", label: "L" })]), DAY)?.headOfState
    ).toHaveLength(1);
  });
  it("empty xml:lang string is treated as untagged", () => {
    const row = wdBinding({ prop: "currency", value: "Q1", label: "Euro" });
    (row.valueLabel as Record<string, string>)["xml:lang"] = "";
    expect(() => parseWikidataResponse(wdBody([row]), DAY)).toThrow(PanelFetchError);
  });
  it("all untagged -> PanelFetchError; empty bindings -> null (cacheable)", () => {
    expect(() => parseWikidataResponse(wdBody([untagged("currency", "Q1"), untagged("headOfState", "Q2")]), DAY)).toThrow(
      PanelFetchError
    );
    expect(parseWikidataResponse(wdBody([]), DAY)).toBeNull();
  });
  it("missing valueLabel entirely (label service dropped) -> throws PanelFetchError, not TypeError", () => {
    const row = wdBinding({ prop: "currency", value: "Q1", label: "A" }) as Record<string, unknown>;
    delete row.valueLabel;
    expect(() => parseWikidataResponse(wdBody([row]), DAY)).toThrow(PanelFetchError);
  });
  it("hostile shapes only ever throw PanelFetchError", () => {
    const bad = { ...wdBinding({ prop: "currency", value: "Q1" }), valueLabel: { type: "literal", value: "x", "xml:lang": 5 } };
    const bodies = [null, 1, "x", [], {}, { results: null }, { results: { bindings: "x" } }, { results: { bindings: [null] } }, { results: { bindings: [{ c: 1 }] } }, wdBody([bad])];
    for (const body of bodies) {
      try {
        parseWikidataResponse(body, DAY);
      } catch (e) {
        expect(e).toBeInstanceOf(PanelFetchError);
      }
    }
  });
});

describe("through the real cache", () => {
  class Mem {
    entries = new Map<string, unknown>();
    isOnDemandRevalidate = false;
    async generateSimpleCacheKey(k: string) {
      return k;
    }
    async get(k: string) {
      return this.entries.has(k) ? { value: this.entries.get(k), isStale: false } : null;
    }
    async set(k: string, v: unknown) {
      this.entries.set(k, v);
    }
  }
  let mem: Mem;
  let wd: unknown;
  let f: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mem = new Mem();
    (globalThis as { __incrementalCache?: unknown }).__incrementalCache = mem;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    wd = wdBody([untagged("currency", "Q1")]);
    f = vi.fn(async (u: string) => {
      if (u.includes("wikidata")) return jsonResponse(wd);
      if (u.includes("/indicator/")) return jsonResponse(wbIndicator("SP.POP.TOTL", "MA", "2025", 1e7));
      return jsonResponse(wbCountry("MA", "Rabat"));
    });
    vi.stubGlobal("fetch", f);
  });
  afterEach(() => {
    delete (globalThis as { __incrementalCache?: unknown }).__incrementalCache;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("unlabelled answer: no throw from getCountryFacts, World Bank still shown, nothing cached for wikidata, then recovers", async () => {
    const r = await getCountryFacts("Morocco");
    expect(r?.worldBank?.capital).toBe("Rabat");
    expect(r?.wikidata).toBeNull();
    expect([...mem.entries.keys()].filter((k) => k.includes("wikidata"))).toHaveLength(0);
    wd = wdMorocco;
    const r2 = await getCountryFacts("Morocco");
    expect(r2?.wikidata?.currency).toHaveLength(1);
    const calls = f.mock.calls.length;
    await getCountryFacts("Morocco");
    expect(f.mock.calls.length).toBe(calls);
  });
  it("fetchWikidataFacts rejects (not resolves) on an unlabelled answer", async () => {
    await expect(fetchWikidataFacts("MA")).rejects.toBeInstanceOf(PanelFetchError);
  });
});
