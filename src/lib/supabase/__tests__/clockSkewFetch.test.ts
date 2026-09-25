import { describe, expect, it, vi } from "vitest";
import { CLOCK_SKEW_RETRY_MS, clockSkewRetryFetch } from "@/lib/supabase/clockSkewFetch";

const skew = () =>
  new Response(JSON.stringify({ code: "PGRST303", message: "JWT issued at future" }), { status: 401 });
const ok = () => new Response("[]", { status: 200 });

describe("clockSkewRetryFetch", () => {
  it("retries once, after the wait, when the token is refused as issued at future", async () => {
    const base = vi.fn().mockResolvedValueOnce(skew()).mockResolvedValueOnce(ok());
    const wait = vi.fn(async () => {});
    const res = await clockSkewRetryFetch(base, wait)("https://x/rest/v1/user_topics", { method: "GET" });
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    expect(base.mock.calls[1][0]).toBe(base.mock.calls[0][0]);
    expect(base.mock.calls[1][1]).toMatchObject({ method: "GET" });
    expect(wait).toHaveBeenCalledWith(CLOCK_SKEW_RETRY_MS);
  });

  it("retries only once, returning the second refusal as-is", async () => {
    const base = vi.fn().mockImplementation(async () => skew());
    const res = await clockSkewRetryFetch(base, async () => {})("https://x/rest/v1/t");
    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("passes any other 401 straight through, with its body intact", async () => {
    const base = vi.fn().mockResolvedValue(new Response('{"message":"JWT expired"}', { status: 401 }));
    const wait = vi.fn(async () => {});
    const res = await clockSkewRetryFetch(base, wait)("https://x/rest/v1/t");
    expect(await res.text()).toBe('{"message":"JWT expired"}');
    expect(base).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it.each([200, 400, 403, 500])("never retries a %i", async (status) => {
    const base = vi.fn().mockResolvedValue(new Response("JWT issued at future", { status }));
    await clockSkewRetryFetch(base, async () => {})("https://x/rest/v1/t");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("leaves the first response's body readable when it doesn't retry", async () => {
    const base = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const res = await clockSkewRetryFetch(base, async () => {})("https://x/rest/v1/t");
    expect(await res.text()).toBe("unauthorized");
  });

  // Next's server-render fetch caches identical calls unless a signal is
  // passed. This stand-in behaves the same way, so a resend that isn't
  // distinguishable would get the cached refusal back.
  it("gets past a dedupe cache like Next's during a server render", async () => {
    const network = vi.fn().mockResolvedValueOnce(skew()).mockResolvedValueOnce(ok());
    const cache = new Map<string, Promise<Response>>();
    const dedupe: typeof fetch = (input, init) => {
      if (init?.signal) return network(input, init);
      const key = JSON.stringify([String(input), init?.method, init?.headers]);
      if (!cache.has(key)) cache.set(key, network(input, init));
      return cache.get(key)!.then((r) => r.clone());
    };
    const res = await clockSkewRetryFetch(dedupe, async () => {})("https://x/rest/v1/user_topics", { method: "GET" });
    expect(res.status).toBe(200);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("keeps a caller's own signal on the resend", async () => {
    const base = vi.fn().mockResolvedValueOnce(skew()).mockResolvedValueOnce(ok());
    const signal = new AbortController().signal;
    await clockSkewRetryFetch(base, async () => {})("https://x/rest/v1/t", { signal });
    expect(base.mock.calls[1][1].signal).toBe(signal);
  });
});
