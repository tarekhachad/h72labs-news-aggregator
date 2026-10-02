// The shared skew wait's default scope is React's `cache`, the same per-render
// scope Next's fetch dedupe uses. Outside an RSC render React's cache keeps
// nothing, so here it is swapped for one memo that stands in for a single
// render, and the retry is built WITHOUT an injected store.
import { beforeEach, describe, expect, it, vi } from "vitest";

let render = new Map<unknown, unknown>();
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    cache: <A extends unknown[], R>(fn: (...a: A) => R) =>
      (...a: A): R => {
        if (!render.has(fn)) render.set(fn, fn(...a));
        return render.get(fn) as R;
      },
  };
});

const { clockSkewRetryFetch } = await import("@/lib/supabase/clockSkewFetch");

const skew = () => new Response('{"code":"PGRST303","message":"JWT issued at future"}', { status: 401 });
const ok = () => new Response("[]", { status: 200 });

let network: ReturnType<typeof vi.fn>;
let wait: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
beforeEach(() => {
  render = new Map();
  network = vi.fn(async (_i: unknown, init?: RequestInit) => (init?.signal ? ok() : skew()));
  wait = vi.fn<(ms: number) => Promise<void>>(async () => {});
});

describe("clockSkewRetryFetch's default wait store", () => {
  it("is shared across clients in one render: two createClient()s' identical GETs pay one wait", async () => {
    const a = clockSkewRetryFetch(network as unknown as typeof fetch, wait);
    const b = clockSkewRetryFetch(network as unknown as typeof fetch, wait);
    await a("https://x/rest/v1/t");
    await b("https://x/rest/v1/t");
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("is fresh for the next render", async () => {
    const f = clockSkewRetryFetch(network as unknown as typeof fetch, wait);
    await f("https://x/rest/v1/t");
    render = new Map();
    await f("https://x/rest/v1/t");
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
