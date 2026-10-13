// First, as in Next's own server: puts AsyncLocalStorage on globalThis, which
// Next's request stores need and the test runner does not provide.
import "next/dist/server/node-environment-baseline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { getCountryFacts, COUNTRY_FACTS_REVALIDATE_SECONDS, COUNTRY_FACTS_TAG } from "../countryFacts";
import { jsonResponse, wbCountry, wbIndicator, wbUnknownCountry, wdMorocco } from "./fixtures";

// Next's real unstable_cache, run against an in-memory stand-in for the
// incremental cache it stores into (on Vercel, the shared data cache). What
// is proved here is Next's own behaviour with these fetchers: what it stores,
// and what it serves when a refresh fails.

type Entry = { value: { kind: string; data: { body: string }; revalidate: number }; tags: string[]; stale: boolean };

class MemoryIncrementalCache {
  entries = new Map<string, Entry>();
  isOnDemandRevalidate = false;
  async generateSimpleCacheKey(key: string) {
    return key;
  }
  async get(key: string) {
    const entry = this.entries.get(key);
    return entry ? { value: entry.value, isStale: entry.stale } : null;
  }
  async set(key: string, value: Entry["value"], ctx: { tags?: string[] }) {
    this.entries.set(key, { value, tags: ctx.tags ?? [], stale: false });
  }
  markAllStale() {
    for (const entry of this.entries.values()) entry.stale = true;
  }
  stored(source: "world-bank" | "wikidata"): unknown[] {
    return [...this.entries]
      .filter(([key]) => key.includes(`country-facts,${source}`))
      .map(([, entry]) => JSON.parse(entry.value.data.body));
  }
}

type Upstream = "ok" | "http-503" | "malformed" | "network" | "unknown";
const state = { worldBank: "ok" as Upstream, wikidata: "ok" as Upstream, population: 38430770 };
let fetchMock: ReturnType<typeof vi.fn>;
let cache: MemoryIncrementalCache;

function answer(mode: Upstream, good: unknown): Response {
  if (mode === "network") throw new TypeError("fetch failed");
  if (mode === "http-503") return jsonResponse({}, { status: 503 });
  if (mode === "malformed") return jsonResponse({ surprise: true });
  if (mode === "unknown") return jsonResponse(wbUnknownCountry);
  return jsonResponse(good);
}

beforeEach(() => {
  cache = new MemoryIncrementalCache();
  (globalThis as { __incrementalCache?: unknown }).__incrementalCache = cache;
  state.worldBank = "ok";
  state.wikidata = "ok";
  state.population = 38430770;
  fetchMock = vi.fn(async (url: string) => {
    const { host, pathname } = new URL(url);
    if (host === "query.wikidata.org") return answer(state.wikidata, wdMorocco);
    if (pathname.endsWith("SP.POP.TOTL")) return answer(state.worldBank, wbIndicator("SP.POP.TOTL", "MA", "2025", state.population));
    if (pathname.includes("/indicator/")) return answer(state.worldBank, wbIndicator("X", "MA", "2024", 1e9));
    return answer(state.worldBank, wbCountry("MA", "Rabat"));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete (globalThis as { __incrementalCache?: unknown }).__incrementalCache;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const worldBankCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("worldbank")).length;
const wikidataCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("wikidata")).length;

describe("country facts in Next's data cache", () => {
  it("stores each source's answer for a day under the panel tag, and serves it without refetching", async () => {
    const first = await getCountryFacts("Morocco");
    expect(first?.worldBank?.capital).toBe("Rabat");
    expect(first?.wikidata?.headOfState[0].label).toBe("Mohammed VI of Morocco");
    for (const entry of cache.entries.values()) {
      expect(entry.value.revalidate).toBe(COUNTRY_FACTS_REVALIDATE_SECONDS);
      expect(entry.tags).toContain(COUNTRY_FACTS_TAG);
    }
    expect(cache.entries.size).toBe(2);

    fetchMock.mockClear();
    await expect(getCountryFacts("Morocco")).resolves.toEqual(first);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<Upstream>(["http-503", "malformed", "network"])(
    "never stores a World Bank failure (%s): the next request tries again",
    async (failure) => {
      state.worldBank = failure;
      const facts = await getCountryFacts("Morocco");
      // The other source still shows.
      expect(facts?.worldBank).toBeNull();
      expect(facts?.wikidata?.currency[0].label).toBe("Moroccan dirham");
      expect(cache.stored("world-bank")).toEqual([]);
      expect(cache.stored("wikidata")).toHaveLength(1);

      state.worldBank = "ok";
      const before = worldBankCalls();
      const retried = await getCountryFacts("Morocco");
      expect(worldBankCalls()).toBe(before + 4);
      expect(retried?.worldBank?.capital).toBe("Rabat");
      expect(cache.stored("world-bank")).toHaveLength(1);
    }
  );

  it.each<Upstream>(["http-503", "malformed", "network"])(
    "never stores a Wikidata failure (%s)",
    async (failure) => {
      state.wikidata = failure;
      const facts = await getCountryFacts("Morocco");
      expect(facts?.wikidata).toBeNull();
      expect(facts?.worldBank?.capital).toBe("Rabat");
      expect(cache.stored("wikidata")).toEqual([]);

      state.wikidata = "ok";
      const before = wikidataCalls();
      await getCountryFacts("Morocco");
      expect(wikidataCalls()).toBe(before + 1);
    }
  );

  it("shows no box when both sources fail, and stores nothing", async () => {
    state.worldBank = "network";
    state.wikidata = "http-503";
    await expect(getCountryFacts("Morocco")).resolves.toBeNull();
    expect(cache.entries.size).toBe(0);
  });

  it("does store a country the World Bank does not know: that is an answer, not a failure", async () => {
    state.worldBank = "unknown";
    const facts = await getCountryFacts("Morocco");
    expect(facts?.worldBank).toBeNull();
    expect(cache.stored("world-bank")).toEqual([null]);

    const before = worldBankCalls();
    await getCountryFacts("Morocco");
    expect(worldBankCalls()).toBe(before);
  });

  it("asks nothing upstream for a name with no ISO code", async () => {
    await expect(getCountryFacts("Atlantis")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps serving the last good copy when a background refresh fails", async () => {
    // Inside a request, as on the live page: Next serves a stale entry at once
    // and refreshes it in the background.
    const store = {
      incrementalCache: cache,
      isDraftMode: false,
      isOnDemandRevalidate: false,
      isStaticGeneration: false,
      fetchCache: undefined,
      nextFetchId: 1,
      pendingRevalidates: {} as Record<string, Promise<unknown>>,
      route: "/topic/[slug]",
    };
    const inRequest = () =>
      workAsyncStorage.run(store as unknown as Parameters<typeof workAsyncStorage.run>[0], () =>
        getCountryFacts("Morocco")
      );
    const settleBackground = async () => {
      await Promise.all(Object.values(store.pendingRevalidates));
      store.pendingRevalidates = {};
    };

    await inRequest();
    await settleBackground();
    expect(cache.stored("world-bank")).toHaveLength(1);

    // A day later: the entries are stale and both upstreams are down.
    cache.markAllStale();
    state.worldBank = "http-503";
    state.wikidata = "network";
    const served = await inRequest();
    await settleBackground();
    expect(served?.worldBank?.population).toEqual({ value: 38430770, year: 2025 });
    expect(served?.wikidata?.headOfGovernment[0].label).toBe("Aziz Akhannouch");
    expect(cache.stored("world-bank")[0]).toMatchObject({ population: { value: 38430770 } });

    // Upstream recovers: the next stale read refreshes in the background...
    state.worldBank = "ok";
    state.wikidata = "ok";
    state.population = 38_500_000;
    const stillOld = await inRequest();
    expect(stillOld?.worldBank?.population?.value).toBe(38430770);
    await settleBackground();
    // ...and the request after it sees the new figure.
    const fresh = await inRequest();
    expect(fresh?.worldBank?.population?.value).toBe(38_500_000);
  });
});
