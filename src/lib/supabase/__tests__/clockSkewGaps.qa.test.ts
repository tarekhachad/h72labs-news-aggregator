// The clock-skew retry's two gaps: a body-less HEAD refusal, and identical
// requests in one render each paying the full wait. Runs Next 16's REAL
// dedupe-fetch, with React's `cache` swapped for a plain memo so one harness
// instance behaves like one server-component render (same approach as
// clockSkewNextDedupe.qa.test.ts).
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { CLOCK_SKEW_RETRY_MS, clockSkewRetryFetch } from "@/lib/supabase/clockSkewFetch";

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

// What PostgREST sends for a token whose iat is ahead of its clock (PGRST303):
// the reason in the body and in WWW-Authenticate.
const SKEW_HEADER = 'Bearer error="invalid_token", error_description="JWT issued at future"';
const skewBody = () =>
  new Response(JSON.stringify({ code: "PGRST303", message: "JWT issued at future" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": SKEW_HEADER },
  });
const skewHead = () => new Response(null, { status: 401, headers: { "www-authenticate": SKEW_HEADER } });
const rows = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const counted = (n: number) => new Response(null, { status: 200, headers: { "content-range": `*/${n}` } });

let network: ReturnType<typeof vi.fn>;
let wait: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
// One render's worth of shared waits, as React's cache would hold them.
let renderWaits: Map<string, Promise<void>>;
beforeEach(() => {
  network = vi.fn();
  wait = vi.fn<(ms: number) => Promise<void>>(async () => {});
  renderWaits = new Map();
});
const inOneRender = () => clockSkewRetryFetch(freshDedupe(network as unknown as typeof fetch), wait, () => renderWaits);

describe("gap (a): a body-less HEAD refusal", () => {
  it("a HEAD 401 that names the skew only in WWW-Authenticate is retried once, after the wait", async () => {
    network.mockResolvedValueOnce(skewHead()).mockResolvedValueOnce(counted(5));
    const res = await inOneRender()("https://x/rest/v1/t?select=*", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[1][1]).toMatchObject({ method: "HEAD" });
    expect(wait).toHaveBeenCalledWith(CLOCK_SKEW_RETRY_MS);
  });

  it.each([
    ["no WWW-Authenticate at all", {}],
    ["a bare Bearer challenge (token required)", { "www-authenticate": "Bearer" }],
    ["another token error", { "www-authenticate": 'Bearer error="invalid_token", error_description="JWT expired"' }],
  ])("a body-less 401 with %s is passed through, not retried", async (_label, headers) => {
    network.mockResolvedValue(new Response(null, { status: 401, headers }));
    const res = await inOneRender()("https://x/rest/v1/t", { method: "HEAD" });
    expect(res.status).toBe(401);
    expect(network).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it.each([403, 400, 500])("the skew header on a %i is never retried", async (status) => {
    network.mockResolvedValue(new Response(null, { status, headers: { "www-authenticate": SKEW_HEADER } }));
    await inOneRender()("https://x/rest/v1/t", { method: "HEAD" });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("a GET 401 with the skew in its header but not its body is retried too", async () => {
    network
      .mockResolvedValueOnce(new Response('{"message":"unauthorized"}', { status: 401, headers: { "www-authenticate": SKEW_HEADER } }))
      .mockResolvedValueOnce(rows([]));
    const res = await inOneRender()("https://x/rest/v1/t");
    expect(res.status).toBe(200);
  });

  it("the retried HEAD's resend carries a live signal, so Next's dedupe sends it instead of replaying the 401", async () => {
    network.mockResolvedValueOnce(skewHead()).mockResolvedValueOnce(counted(1));
    await inOneRender()("https://x/rest/v1/t", { method: "HEAD", headers: { apikey: "k" } });
    const sig = network.mock.calls[1][1]?.signal as AbortSignal;
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig.aborted).toBe(false);
  });

  it("end to end through supabase-js: a skewed count-only select resolves with the count, not a PGRST303 error", async () => {
    network.mockResolvedValueOnce(skewHead()).mockResolvedValueOnce(counted(7));
    const sb = createSupabaseJs("https://x.supabase.co", "sb_publishable_dummy", {
      global: { fetch: inOneRender() },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { count, error } = await sb.from("cards").select("*", { count: "exact", head: true });
    expect(error).toBeNull();
    expect(count).toBe(7);
    expect(network.mock.calls.map((c) => c[1]?.method)).toEqual(["HEAD", "HEAD"]);
  });
});

describe("gap (b): identical requests in one render share one wait", () => {
  it("a later identical GET, answered from Next's cache with the same refusal, resends without a second wait", async () => {
    network.mockResolvedValueOnce(skewBody()).mockResolvedValue(rows(["ok"]));
    const f = inOneRender();
    const init = { method: "GET", headers: { apikey: "k", authorization: "Bearer t1" } };
    expect((await f("https://x/rest/v1/t", init)).status).toBe(200);
    expect((await f("https://x/rest/v1/t", init)).status).toBe(200);
    expect(wait).toHaveBeenCalledTimes(1);
    // 1 refused + 1 resend each; the second caller never reached the network first
    expect(network).toHaveBeenCalledTimes(3);
  });

  it("concurrent identical GETs wait on the same timer and both recover", async () => {
    let release!: () => void;
    wait.mockImplementation(() => new Promise<void>((r) => (release = r)));
    network.mockResolvedValueOnce(skewBody()).mockResolvedValue(rows(["ok"]));
    const f = inOneRender();
    const init = { method: "GET", headers: { apikey: "k" } };
    const both = Promise.all([f("https://x/rest/v1/t", init), f("https://x/rest/v1/t", init)]);
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
    // Neither resends before the one wait ends.
    await new Promise((r) => setTimeout(r, 10));
    expect(network).toHaveBeenCalledTimes(1);
    release();
    const [a, b] = await both;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(3);
  });

  it("identical HEADs share a wait the same way", async () => {
    network.mockResolvedValueOnce(skewHead()).mockResolvedValue(counted(2));
    const f = inOneRender();
    await f("https://x/rest/v1/t", { method: "HEAD" });
    await f("https://x/rest/v1/t", { method: "HEAD" });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a different URL", ["https://x/rest/v1/a", {}], ["https://x/rest/v1/b", {}]],
    ["a different query", ["https://x/rest/v1/t?select=a", {}], ["https://x/rest/v1/t?select=b", {}]],
    ["a different token", ["https://x/rest/v1/t", { headers: { authorization: "Bearer t1" } }], ["https://x/rest/v1/t", { headers: { authorization: "Bearer t2" } }]],
    ["a different method", ["https://x/rest/v1/t", { method: "GET" }], ["https://x/rest/v1/t", { method: "HEAD" }]],
  ] as const)("requests that differ by %s each pay their own wait", async (_label, [u1, i1], [u2, i2]) => {
    network.mockImplementation(async (_input: unknown, init?: RequestInit) => (init?.signal ? rows([]) : (init?.method === "HEAD" ? skewHead() : skewBody())));
    const f = inOneRender();
    expect((await f(u1, i1 as RequestInit)).status).toBe(200);
    expect((await f(u2, i2 as RequestInit)).status).toBe(200);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("each request still gets its own response, never another's", async () => {
    network.mockImplementation(async (input: string, init?: RequestInit) => (init?.signal ? rows([input]) : skewBody()));
    const f = inOneRender();
    const a = await f("https://x/rest/v1/a");
    const b = await f("https://x/rest/v1/b");
    expect(await a.json()).toEqual(["https://x/rest/v1/a"]);
    expect(await b.json()).toEqual(["https://x/rest/v1/b"]);
  });

  it("writes are never sharers: two identical POSTs each wait", async () => {
    network.mockImplementation(async (_i: unknown, init?: RequestInit) => (init?.signal ? rows([]) : skewBody()));
    const f = inOneRender();
    const init = { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } };
    await f("https://x/rest/v1/t", init);
    await f("https://x/rest/v1/t", init);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("a streamed POST body is left untouched for the resend", async () => {
    network.mockImplementationOnce(async () => skewBody()).mockImplementationOnce(async () => rows([]));
    const body = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("{}")), c.close()) });
    const res = await clockSkewRetryFetch(network as unknown as typeof fetch, wait, () => renderWaits)("https://x/rest/v1/rpc/f", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(200);
    expect(body.locked).toBe(false);
    expect(network.mock.calls[1][1].body).toBe(body);
  });

  it("a second render does not inherit the first one's wait", async () => {
    network.mockImplementation(async (_i: unknown, init?: RequestInit) => (init?.signal ? rows([]) : skewBody()));
    await inOneRender()("https://x/rest/v1/t");
    renderWaits = new Map();
    await inOneRender()("https://x/rest/v1/t");
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("outside a render (React's cache keeps nothing there) every refusal waits for itself, as before", async () => {
    network.mockImplementation(async (_i: unknown, init?: RequestInit) => (init?.signal ? rows([]) : skewBody()));
    const f = clockSkewRetryFetch(network as unknown as typeof fetch, wait);
    await f("https://x/rest/v1/t");
    await f("https://x/rest/v1/t");
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("only once: a resend refused again is returned as-is, and the next identical request does not loop", async () => {
    network.mockImplementation(async (_i: unknown, init?: RequestInit) => (init?.method === "HEAD" ? skewHead() : skewBody()));
    const f = inOneRender();
    expect((await f("https://x/rest/v1/t")).status).toBe(401);
    expect((await f("https://x/rest/v1/t")).status).toBe(401);
    // 1 refused + 1 refused resend; the second caller gets the cached refusal
    // and makes exactly one resend of its own
    expect(network).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
