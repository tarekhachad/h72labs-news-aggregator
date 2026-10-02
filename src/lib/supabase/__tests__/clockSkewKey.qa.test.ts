// QA round 1: the shared skew wait's key and its edges, behind Next 16's REAL
// dedupe-fetch (React's `cache` swapped for a plain memo so one harness
// instance is one render, as in clockSkewNextDedupe.qa.test.ts).
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const SKEW_HEADER = 'Bearer error="invalid_token", error_description="JWT issued at future"';
const skewBody = () =>
  new Response(JSON.stringify({ code: "PGRST303", message: "JWT issued at future" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": SKEW_HEADER },
  });
const skewHead = () => new Response(null, { status: 401, headers: { "www-authenticate": SKEW_HEADER } });
const rows = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

let network: ReturnType<typeof vi.fn>;
let wait: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
let renderWaits: Map<string, Promise<void>>;
beforeEach(() => {
  network = vi.fn();
  wait = vi.fn<(ms: number) => Promise<void>>(async () => {});
  renderWaits = new Map();
});
const inOneRender = () => clockSkewRetryFetch(freshDedupe(network as unknown as typeof fetch), wait, () => renderWaits);
const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
// Every first send is refused; every resend (it carries a signal) succeeds.
const refuseFirstSend = () =>
  network.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (init?.signal) return method === "HEAD" ? new Response(null, { status: 200 }) : rows([urlOf(input)]);
    return method === "HEAD" ? skewHead() : skewBody();
  });

describe("what counts as the same request", () => {
  it("a lowercase 'head' with the reason only in WWW-Authenticate is retried, and its twin shares the wait", async () => {
    refuseFirstSend();
    const f = inOneRender();
    expect((await f("https://x/rest/v1/t", { method: "head" })).status).toBe(200);
    expect((await f("https://x/rest/v1/t", { method: "head" })).status).toBe(200);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(CLOCK_SKEW_RETRY_MS);
  });

  it("header names that differ only in case are the same request (Headers normalises them)", async () => {
    refuseFirstSend();
    const f = inOneRender();
    await f("https://x/rest/v1/t", { headers: { Authorization: "Bearer t1" } });
    await f("https://x/rest/v1/t", { headers: { authorization: "Bearer t1" } });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("a Request object and the same URL+init as a string are the same request", async () => {
    refuseFirstSend();
    const f = inOneRender();
    await f(new Request("https://x/rest/v1/t", { headers: { apikey: "k" } }));
    await f("https://x/rest/v1/t", { headers: { apikey: "k" } });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("a URL object input is keyed like its string form", async () => {
    refuseFirstSend();
    const f = inOneRender();
    await f(new URL("https://x/rest/v1/t"));
    await f("https://x/rest/v1/t");
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("a differing apikey header is a different request: two waits", async () => {
    refuseFirstSend();
    const f = inOneRender();
    await f("https://x/rest/v1/t", { headers: { apikey: "k1" } });
    await f("https://x/rest/v1/t", { headers: { apikey: "k2" } });
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("a keepalive GET never shares (Next does not dedupe it either)", async () => {
    refuseFirstSend();
    const f = inOneRender();
    await f("https://x/rest/v1/t", { keepalive: true });
    await f("https://x/rest/v1/t", { keepalive: true });
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("a POST Request object (method on the Request, not init) is never a sharer", async () => {
    refuseFirstSend();
    const f = inOneRender();
    await f(new Request("https://x/rest/v1/rpc/f", { method: "POST", body: "{}" }));
    await f(new Request("https://x/rest/v1/rpc/f", { method: "POST", body: "{}" }));
    expect(wait).toHaveBeenCalledTimes(2);
  });
});

describe("staggered and concurrent waits", () => {
  it("a twin refused while the first wait is in flight joins it and resends once it ends, not before", async () => {
    let release!: () => void;
    wait.mockImplementation(() => new Promise<void>((r) => (release = r)));
    refuseFirstSend();
    const f = inOneRender();
    const first = f("https://x/rest/v1/t", { headers: { apikey: "k" } });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
    const second = f("https://x/rest/v1/t", { headers: { apikey: "k" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(network.mock.calls.filter((c) => c[1]?.signal)).toHaveLength(0);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("two different requests refused together wait on separate timers", async () => {
    const releases: Array<() => void> = [];
    wait.mockImplementation(() => new Promise<void>((r) => releases.push(r)));
    refuseFirstSend();
    const f = inOneRender();
    const a = f("https://x/rest/v1/a");
    const b = f("https://x/rest/v1/b");
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2));
    releases[0]();
    expect((await a).status).toBe(200);
    // b's own timer has not fired, so b has not resent yet
    expect(network.mock.calls.filter((c) => c[1]?.signal).map((c) => urlOf(c[0]))).toEqual(["https://x/rest/v1/a"]);
    releases[1]();
    expect((await b).status).toBe(200);
  });

  it("a response that is not a skew refusal never touches the shared store", async () => {
    network.mockResolvedValue(new Response("{}", { status: 401 }));
    const store = vi.fn(() => renderWaits);
    await clockSkewRetryFetch(freshDedupe(network as unknown as typeof fetch), wait, store)("https://x/rest/v1/t");
    expect(store).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(renderWaits.size).toBe(0);
  });

  it("a caller-supplied signal is kept on the resend (no fresh one replaces it)", async () => {
    const ac = new AbortController();
    network.mockImplementationOnce(async () => skewBody()).mockImplementationOnce(async () => rows([]));
    await inOneRender()("https://x/rest/v1/t", { signal: ac.signal });
    expect(network.mock.calls[1][1].signal).toBe(ac.signal);
  });
});

describe("pinned edge: requests Next would NOT dedupe can still share a wait", () => {
  // Next's dedupe keys on more than method+URL+headers, and a signal opts a
  // request out of it entirely. The wait store keys on method+URL+headers
  // only, so two signal-bearing twins (never deduped by Next) share one wait.
  // Same URL and token, so the second resend goes no earlier than the first
  // one's did. Pinned so a change to it is a decision, not an accident.
  it("two identical GETs each carrying their own signal share one wait", async () => {
    let n = 0;
    network.mockImplementation(async () => (++n % 2 === 1 ? skewBody() : rows([])));
    const f = inOneRender();
    await f("https://x/rest/v1/t", { signal: new AbortController().signal });
    await f("https://x/rest/v1/t", { signal: new AbortController().signal });
    expect(network).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
