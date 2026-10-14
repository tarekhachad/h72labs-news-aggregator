// First, as in Next's own server: puts AsyncLocalStorage on globalThis, which
// Next's request stores need and the test runner does not provide.
import "next/dist/server/node-environment-baseline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { jsonResponse } from "./fixtures";
import { eiaLatest, frankfurterPair, treasuryFeed, xmlResponse } from "./ratesFixtures";

// Next's real unstable_cache, run against an in-memory stand-in for the
// incremental cache it stores into (on Vercel, the shared data cache), as in
// countryFactsCache.test.ts. The module is re-imported per test so its
// once-per-process "no EIA key" line starts unlogged each time.

type Entry = { value: { kind: string; data: { body: string }; revalidate: number }; tags: string[]; stale: boolean };
type Source = "treasury" | "frankfurter" | "eia";

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
  stored(source: Source): unknown[] {
    return [...this.entries]
      .filter(([key]) => key.includes(`rates,${source}`))
      .map(([, entry]) => JSON.parse(entry.value.data.body));
  }
}

type Upstream = "ok" | "http-503" | "malformed" | "network";
const state = { treasury: "ok" as Upstream, frankfurter: "ok" as Upstream, eia: "ok" as Upstream, tenYear: "5.21" };
const KEY = "test-key-0123456789abcdef";
let fetchMock: ReturnType<typeof vi.fn>;
let cache: MemoryIncrementalCache;
let rates: typeof import("../rates");

function answer(mode: Upstream, good: () => Response): Response {
  if (mode === "network") throw new TypeError("fetch failed");
  if (mode === "http-503") return jsonResponse({}, { status: 503 });
  if (mode === "malformed") return jsonResponse({ surprise: true });
  return good();
}

beforeEach(async () => {
  cache = new MemoryIncrementalCache();
  (globalThis as { __incrementalCache?: unknown }).__incrementalCache = cache;
  Object.assign(state, { treasury: "ok", frankfurter: "ok", eia: "ok", tenYear: "5.21" });
  vi.stubEnv("EIA_API_KEY", KEY);
  fetchMock = vi.fn(async (url: string) => {
    const { host, pathname } = new URL(url);
    if (host === "home.treasury.gov") {
      return answer(state.treasury, () =>
        xmlResponse(treasuryFeed([{ date: "2026-10-13", tenYear: state.tenYear }]))
      );
    }
    if (host === "api.frankfurter.dev") {
      const [base, quote] = pathname.split("/").slice(-2);
      return answer(state.frankfurter, () => jsonResponse(frankfurterPair(base, quote, base === "EUR" ? 1.1199 : 9.7515)));
    }
    if (host === "api.eia.gov") return answer(state.eia, () => jsonResponse(eiaLatest));
    throw new Error(`unexpected host ${host}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  rates = await import("../rates");
});

afterEach(() => {
  delete (globalThis as { __incrementalCache?: unknown }).__incrementalCache;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const callsTo = (host: string) => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).host === host).length;

describe("the rates strip in Next's data cache", () => {
  it("stores each source's answer for a day under the panel tag, and serves it without refetching", async () => {
    const first = await rates.getRatesStrip();
    expect(first).toEqual({
      tenYear: { value: 5.21, date: "2026-10-13" },
      fx: { eurUsd: { value: 1.1199, date: "2026-10-13" }, usdMad: { value: 9.7515, date: "2026-10-13" } },
      oil: { brent: { value: 125.44, date: "2026-10-06" }, wti: { value: 96.24, date: "2026-10-06" } },
    });
    expect(cache.entries.size).toBe(3);
    for (const [key, entry] of cache.entries) {
      expect(entry.value.revalidate).toBe(rates.RATES_REVALIDATE_SECONDS);
      expect(entry.tags).toContain(rates.RATES_TAG);
      expect(key).not.toContain(KEY);
    }

    fetchMock.mockClear();
    await expect(rates.getRatesStrip()).resolves.toEqual(first);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[Source, string]>([
    ["treasury", "home.treasury.gov"],
    ["frankfurter", "api.frankfurter.dev"],
    ["eia", "api.eia.gov"],
  ])("never stores a %s failure, keeps the others, and retries on the next request", async (source, host) => {
    for (const failure of ["http-503", "malformed", "network"] as const) {
      cache.entries.clear();
      state[source] = failure;
      const data = await rates.getRatesStrip();
      expect(data).not.toBeNull();
      expect(data![source === "treasury" ? "tenYear" : source === "frankfurter" ? "fx" : "oil"]).toBeNull();
      expect(cache.stored(source)).toEqual([]);
      expect(cache.entries.size).toBe(2);

      state[source] = "ok";
      const before = callsTo(host);
      await rates.getRatesStrip();
      expect(callsTo(host)).toBeGreaterThan(before);
      expect(cache.stored(source)).toHaveLength(1);
    }
  });

  it("shows no strip when every source fails, and stores nothing", async () => {
    Object.assign(state, { treasury: "network", frankfurter: "http-503", eia: "malformed" });
    await expect(rates.getRatesStrip()).resolves.toBeNull();
    expect(cache.entries.size).toBe(0);
  });

  it("without an EIA key: no oil request, nothing cached for oil, and one log line per process", async () => {
    vi.stubEnv("EIA_API_KEY", "");
    const log = vi.mocked(console.log);
    const first = await rates.getRatesStrip();
    await rates.getRatesStrip();
    expect(first?.oil).toBeNull();
    expect(first?.tenYear?.value).toBe(5.21);
    expect(callsTo("api.eia.gov")).toBe(0);
    expect(cache.stored("eia")).toEqual([]);
    expect(log.mock.calls.filter(([line]) => String(line).includes("EIA_API_KEY"))).toHaveLength(1);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();

    // A key added later is used at once: nothing was cached in its absence.
    vi.stubEnv("EIA_API_KEY", KEY);
    const withKey = await rates.getRatesStrip();
    expect(withKey?.oil?.wti?.value).toBe(96.24);
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
        rates.getRatesStrip()
      );
    const settleBackground = async () => {
      await Promise.all(Object.values(store.pendingRevalidates));
      store.pendingRevalidates = {};
    };

    await inRequest();
    await settleBackground();
    expect(cache.entries.size).toBe(3);

    // A day later: the entries are stale and every upstream is down.
    cache.markAllStale();
    Object.assign(state, { treasury: "http-503", frankfurter: "network", eia: "malformed" });
    const served = await inRequest();
    await settleBackground();
    expect(served?.tenYear?.value).toBe(5.21);
    expect(served?.fx?.usdMad.value).toBe(9.7515);
    expect(served?.oil?.brent?.value).toBe(125.44);
    expect(cache.stored("treasury")[0]).toEqual({ value: 5.21, date: "2026-10-13" });

    // Upstream recovers: the next stale read refreshes in the background...
    Object.assign(state, { treasury: "ok", frankfurter: "ok", eia: "ok", tenYear: "5.30" });
    const stillOld = await inRequest();
    expect(stillOld?.tenYear?.value).toBe(5.21);
    await settleBackground();
    // ...and the request after it sees the new figure.
    const fresh = await inRequest();
    expect(fresh?.tenYear?.value).toBe(5.3);
  });
});
