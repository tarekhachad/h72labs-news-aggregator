import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { CLOCK_SKEW_RETRY_MS, clockSkewRetryFetch } from "@/lib/supabase/clockSkewFetch";

const SKEW_BODY = JSON.stringify({ code: "PGRST303", details: null, hint: null, message: "JWT issued at future" });
const skew = () => new Response(SKEW_BODY, { status: 401, headers: { "content-type": "application/json" } });
const noWait = async () => {};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("clockSkewRetryFetch — retry bounds", () => {
  it("never calls base more than twice, whatever base keeps returning", async () => {
    const base = vi.fn(async () => skew());
    const wait = vi.fn(noWait);
    const res = await clockSkewRetryFetch(base, wait)("https://x/rest/v1/rpc/reserve_spend", { method: "POST", body: "{}" });
    expect(base).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(SKEW_BODY); // second refusal returned readable
  });

  it("a POST is resent once with the same method, headers and body, plus a signal", async () => {
    const init = { method: "POST", headers: { a: "1" }, body: '{"p":1}' };
    const base = vi.fn().mockResolvedValueOnce(skew()).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await clockSkewRetryFetch(base, noWait)("https://x/rest/v1/rpc/persist_generated_cards", init);
    expect(base).toHaveBeenCalledTimes(2);
    expect(base.mock.calls[1][0]).toBe(base.mock.calls[0][0]);
    expect(base.mock.calls[1][1]).toMatchObject(init);
    expect(base.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("waits the full CLOCK_SKEW_RETRY_MS by default before retrying", async () => {
    vi.useFakeTimers();
    const base = vi.fn().mockResolvedValueOnce(skew()).mockResolvedValueOnce(new Response("ok"));
    const p = clockSkewRetryFetch(base)("https://x/rest/v1/t");
    await vi.advanceTimersByTimeAsync(CLOCK_SKEW_RETRY_MS - 1);
    expect(base).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(base).toHaveBeenCalledTimes(2);
    expect(await (await p).text()).toBe("ok");
  });

  it("a thrown network error on the first call propagates and is not retried", async () => {
    const base = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(clockSkewRetryFetch(base, noWait)("https://x/rest/v1/t")).rejects.toThrow("fetch failed");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("is case-sensitive to the PostgREST message (a lowercase variant is not retried)", async () => {
    const base = vi.fn(async () => new Response('{"message":"jwt issued at future"}', { status: 401 }));
    await clockSkewRetryFetch(base, noWait)("https://x/rest/v1/t");
    expect(base).toHaveBeenCalledTimes(1);
  });
});

describe("clockSkewRetryFetch — body handling", () => {
  function trackedStream(chunks: string[]) {
    let pulls = 0;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        const c = chunks.shift();
        if (c === undefined) controller.close();
        else controller.enqueue(enc.encode(c));
      },
    });
    return { stream, pulls: () => pulls };
  }

  it("a 200 with a streaming body is returned untouched (same object, no reads)", async () => {
    const { stream } = trackedStream(["a", "b", "c"]);
    const original = new Response(stream, { status: 200 });
    const base = vi.fn(async () => original);
    const res = await clockSkewRetryFetch(base, noWait)("https://x/rest/v1/t");
    expect(res).toBe(original);
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe("abc");
  });

  it("a non-skew 401 with a streaming body is returned with the whole body intact", async () => {
    const { stream } = trackedStream(['{"message":', '"JWT expired"}']);
    const original = new Response(stream, { status: 401 });
    const base = vi.fn(async () => original);
    const res = await clockSkewRetryFetch(base, noWait)("https://x/rest/v1/t");
    expect(res).toBe(original);
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe('{"message":"JWT expired"}');
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("a skew message split across stream chunks is still detected", async () => {
    const { stream } = trackedStream(['{"message":"JWT issu', 'ed at future"}']);
    const base = vi.fn().mockResolvedValueOnce(new Response(stream, { status: 401 })).mockResolvedValueOnce(new Response("ok"));
    const res = await clockSkewRetryFetch(base, noWait)("https://x/rest/v1/t");
    expect(await res.text()).toBe("ok");
  });

  it("a 401 whose body errors mid-read is passed through, not thrown", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.error(new Error("socket reset"));
      },
    });
    const original = new Response(stream, { status: 401 });
    const base = vi.fn(async () => original);
    const res = await clockSkewRetryFetch(base, noWait)("https://x/rest/v1/t");
    expect(res).toBe(original);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("LIMIT: a Request input with a body cannot be resent (documents why it matters that supabase-js passes strings)", async () => {
    // A base that behaves like real fetch w.r.t. Request bodies: it consumes them.
    const base = vi.fn(async (input: RequestInfo | URL) => {
      if (input instanceof Request) await input.text();
      return skew();
    });
    const req = new Request("https://x/rest/v1/t", { method: "POST", body: "{}" });
    await expect(clockSkewRetryFetch(base as typeof fetch, noWait)(req)).rejects.toThrow();
  });

  it("LIMIT: a ReadableStream init.body cannot be resent", async () => {
    const base = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      await new Response(init!.body as ReadableStream).text();
      return skew();
    });
    const body = new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode("{}")); c.close(); } });
    await expect(
      clockSkewRetryFetch(base as typeof fetch, noWait)("https://x/rest/v1/t", { method: "POST", body, duplex: "half" } as RequestInit)
    ).rejects.toThrow();
  });
});

describe("clockSkewRetryFetch under real supabase-js (what it actually passes)", () => {
  function client(base: typeof fetch) {
    return createSupabaseJs("https://proj.supabase.test", "sb_publishable_dummy", {
      global: { fetch: clockSkewRetryFetch(base, noWait) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  it("rpc() passes a string URL and a string body, and a skewed rpc is sent exactly twice", async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(skew())
      .mockResolvedValueOnce(new Response("true", { status: 200, headers: { "content-type": "application/json" } }));
    const { data, error } = await client(base).rpc("reserve_spend", { p_amount: 1 });
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect(base).toHaveBeenCalledTimes(2);
    for (const [input, init] of base.mock.calls) {
      expect(typeof input).toBe("string");
      expect(typeof init.body).toBe("string");
      expect(input).not.toBeInstanceOf(Request);
    }
    expect(base.mock.calls[1][1].body).toBe(base.mock.calls[0][1].body);
  });

  it("insert() is sent at most twice even if both attempts are refused, and surfaces the PGRST303 error", async () => {
    const base = vi.fn(async () => skew());
    const { error } = await client(base).from("bookmarks").insert({ card_id: "c" });
    expect(base).toHaveBeenCalledTimes(2);
    expect(error?.code).toBe("PGRST303");
  });

  it("a non-skew 401 reaches supabase-js with its body readable (error parsed)", async () => {
    const base = vi.fn(async () => new Response(JSON.stringify({ code: "PGRST301", message: "JWT expired" }), { status: 401, headers: { "content-type": "application/json" } }));
    const { error } = await client(base).from("t").select();
    expect(base).toHaveBeenCalledTimes(1);
    expect(error?.message).toBe("JWT expired");
  });

  it("auth-js calls also go through the wrapper (string URL input)", async () => {
    const base = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: "bad_jwt", msg: "invalid JWT" }), { status: 403, headers: { "content-type": "application/json" } }));
    await client(base as unknown as typeof fetch).auth.getUser("h.e30.s");
    expect(base).toHaveBeenCalled();
    for (const [input] of base.mock.calls) expect(typeof input).toBe("string");
  });
});

describe("server.ts wiring", () => {
  it("the server client retries a skewed PostgREST call through global fetch", async () => {
    vi.doMock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_dummy");
    const fake = vi
      .fn<(...a: unknown[]) => Promise<Response>>()
      .mockResolvedValueOnce(skew())
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fake);
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const t0 = Date.now();
    const { data, error } = await supabase.from("user_topics").select();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(CLOCK_SKEW_RETRY_MS - 50);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(fake).toHaveBeenCalledTimes(2);
    expect(String(fake.mock.calls[0][0])).toContain("proj.supabase.test/rest/v1/user_topics");
    vi.doUnmock("next/headers");
  }, 10_000);
});
