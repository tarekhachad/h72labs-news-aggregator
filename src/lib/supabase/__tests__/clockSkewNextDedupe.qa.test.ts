import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { clockSkewRetryFetch } from "@/lib/supabase/clockSkewFetch";

// Runs Next 16's REAL dedupe-fetch (the layer that swallowed the retry inside
// a server-component render). Outside an RSC render React.cache doesn't
// memoize, so React's `cache` is swapped for a plain memo on the exact
// module instance dedupe-fetch requires. Everything else is Next's own code:
// the cache key, the signal opt-out, the GET/HEAD rule and cloneResponse.
const req = createRequire(import.meta.url);
const dedupePath = req.resolve("next/dist/server/lib/dedupe-fetch.js");
const reactPath = createRequire(dedupePath).resolve("react");
const realReact = req(reactPath);
function memo<A, R>(fn: (a: A) => R): (a: A) => R {
  const m = new Map<A, R>();
  return (a) => {
    if (!m.has(a)) m.set(a, fn(a));
    return m.get(a)!;
  };
}
function freshDedupe(network: typeof fetch): typeof fetch {
  delete req.cache[dedupePath];
  const mod = req.cache[reactPath]!;
  const saved = mod.exports;
  mod.exports = { ...realReact, cache: memo };
  try {
    const { createDedupeFetch } = req(dedupePath);
    return createDedupeFetch(network);
  } finally {
    mod.exports = saved;
    delete req.cache[dedupePath];
  }
}

const SKEW = JSON.stringify({ code: "PGRST303", details: null, hint: null, message: "JWT issued at future" });
const skew = () => new Response(SKEW, { status: 401, headers: { "content-type": "application/json" } });
const rows = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const noWait = async () => {};

let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn();
});

describe("clockSkewRetryFetch behind Next's real dedupe-fetch", () => {
  it("sanity: the harness really dedupes identical GETs (second call never reaches the network)", async () => {
    network.mockResolvedValue(rows([1]));
    const f = freshDedupe(network as unknown as typeof fetch);
    await f("https://x/rest/v1/t", { method: "GET", headers: { a: "1" } });
    const r2 = await f("https://x/rest/v1/t", { method: "GET", headers: { a: "1" } });
    expect(await r2.json()).toEqual([1]);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("a skewed GET is re-sent to the network and the page gets the 200", async () => {
    network.mockResolvedValueOnce(skew()).mockResolvedValueOnce(rows([{ topic: "Tech/AI" }]));
    const f = clockSkewRetryFetch(freshDedupe(network as unknown as typeof fetch), noWait);
    const res = await f("https://x/rest/v1/user_topics?select=topic", { method: "GET", headers: { apikey: "k" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ topic: "Tech/AI" }]);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("a skewed fetch(url) with no init at all is still re-sent", async () => {
    network.mockResolvedValueOnce(skew()).mockResolvedValueOnce(rows([]));
    const f = clockSkewRetryFetch(freshDedupe(network as unknown as typeof fetch), noWait);
    const res = await f("https://x/rest/v1/t");
    expect(res.status).toBe(200);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("the first call is passed through untouched, so ordinary dedupe still works", async () => {
    network.mockResolvedValue(rows([7]));
    const f = clockSkewRetryFetch(freshDedupe(network as unknown as typeof fetch), noWait);
    const init = { method: "GET", headers: { apikey: "k" } };
    await f("https://x/rest/v1/t", init);
    await f("https://x/rest/v1/t", init);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1]).toBe(init);
  });

  it("a later identical GET in the same render gets the cached 401, retries, and still recovers", async () => {
    network.mockResolvedValueOnce(skew()).mockResolvedValue(rows(["ok"]));
    const f = clockSkewRetryFetch(freshDedupe(network as unknown as typeof fetch), noWait);
    const init = { method: "GET", headers: { apikey: "k" } };
    expect((await f("https://x/rest/v1/t", init)).status).toBe(200);
    expect((await f("https://x/rest/v1/t", init)).status).toBe(200);
    // 1 refused + 1 retry + 1 retry for the second caller (the memo still holds the 401)
    expect(network).toHaveBeenCalledTimes(3);
  });

  it("end to end through supabase-js: a skewed select() resolves with data, not a PGRST303 error", async () => {
    network.mockResolvedValueOnce(skew()).mockResolvedValueOnce(rows([{ topic: "Tech/AI" }]));
    const sb = createSupabaseJs("https://x.supabase.co", "sb_publishable_dummy", {
      global: { fetch: clockSkewRetryFetch(freshDedupe(network as unknown as typeof fetch), noWait) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.from("user_topics").select("topic").eq("user_id", "u");
    expect(error).toBeNull();
    expect(data).toEqual([{ topic: "Tech/AI" }]);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("the resend's fresh signal is live (not aborted)", async () => {
    network.mockResolvedValueOnce(skew()).mockResolvedValueOnce(rows([]));
    const f = clockSkewRetryFetch(freshDedupe(network as unknown as typeof fetch), noWait);
    await f("https://x/rest/v1/t", { method: "GET" });
    const sig = network.mock.calls[1][1]?.signal as AbortSignal;
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig.aborted).toBe(false);
  });
});
