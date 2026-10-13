import "next/dist/server/node-environment-baseline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCountryFacts } from "../countryFacts";
import { jsonResponse, wbCountry, wbIndicator, wdMorocco, wbUnknownCountry } from "./fixtures";

class Mem {
  entries = new Map<string, { value: unknown; stale: boolean }>();
  isOnDemandRevalidate = false;
  async generateSimpleCacheKey(k: string) {
    return k;
  }
  async get(k: string) {
    const e = this.entries.get(k);
    return e ? { value: e.value, isStale: e.stale } : null;
  }
  async set(k: string, v: unknown) {
    this.entries.set(k, { value: v, stale: false });
  }
}

let mem: Mem;
let wdMode: "fail" | "ok" | "empty-labels";
let wbMode: "ok" | "unknown" | "half";
let f: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mem = new Mem();
  (globalThis as { __incrementalCache?: unknown }).__incrementalCache = mem;
  wdMode = "fail";
  wbMode = "ok";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  f = vi.fn(async (u: string) => {
    if (u.includes("wikidata")) return wdMode === "fail" ? jsonResponse({}, { status: 500 }) : jsonResponse(wdMorocco);
    if (wbMode === "unknown") return jsonResponse(wbUnknownCountry);
    if (wbMode === "half" && u.includes("NY.GDP")) return jsonResponse({}, { status: 502 });
    if (u.includes("SP.POP")) return jsonResponse(wbIndicator("SP.POP.TOTL", "MA", "2025", 1e7));
    if (u.includes("/indicator/")) return jsonResponse(wbIndicator("X", "MA", "2024", 5));
    return jsonResponse(wbCountry("MA", "Rabat"));
  });
  vi.stubGlobal("fetch", f);
});
afterEach(() => {
  delete (globalThis as { __incrementalCache?: unknown }).__incrementalCache;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("partial failure through Next's real unstable_cache", () => {
  it("wikidata fails once while WB is cached: next request refetches only wikidata, then all cached", async () => {
    const r1 = await getCountryFacts("Morocco");
    expect(r1?.worldBank?.capital).toBe("Rabat");
    expect(r1?.wikidata).toBeNull();
    expect([...mem.entries.keys()].filter((k) => k.includes("wikidata"))).toHaveLength(0);

    wdMode = "ok";
    const before = f.mock.calls.length;
    const r2 = await getCountryFacts("Morocco");
    expect(r2?.wikidata?.currency).toHaveLength(1);
    expect(f.mock.calls.length - before).toBe(1);
    await getCountryFacts("Morocco");
    expect(f.mock.calls.length - before).toBe(1);
  });

  it("one World Bank indicator failing stores NOTHING for World Bank (no half-answer cached)", async () => {
    wbMode = "half";
    wdMode = "ok";
    const r = await getCountryFacts("Morocco");
    expect(r?.worldBank).toBeNull();
    expect([...mem.entries.keys()].filter((k) => k.includes("world-bank"))).toHaveLength(0);
    wbMode = "ok";
    const r2 = await getCountryFacts("Morocco");
    expect(r2?.worldBank?.population?.value).toBe(1e7);
  });

  it("unknown-country null is cached (no refetch), and yields no facts", async () => {
    wbMode = "unknown";
    wdMode = "fail";
    expect(await getCountryFacts("Morocco")).toBeNull();
    const n = f.mock.calls.length;
    expect(await getCountryFacts("Morocco")).toBeNull();
    // WB null cached -> only wikidata (failed, uncached) refetched
    expect(f.mock.calls.length - n).toBe(1);
  });

  it("different countries do not share cache entries", async () => {
    wdMode = "ok";
    await getCountryFacts("Morocco");
    const n = f.mock.calls.length;
    await getCountryFacts("France");
    expect(f.mock.calls.length - n).toBe(5);
  });
});
