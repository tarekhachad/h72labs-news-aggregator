import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCappedJson, PANEL_TIMEOUT_MS, PANEL_USER_AGENT, PanelFetchError } from "../fetchJson";
import { jsonResponse } from "./fixtures";

const URL_ = "https://api.example.org/data";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("fetchCappedJson", () => {
  it("returns the parsed body, sent uncached with the panel User-Agent, a timeout and no redirects", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: 1 }));
    await expect(fetchCappedJson(URL_, { maxBytes: 1000 })).resolves.toEqual({ ok: 1 });

    const init = fetchMock.mock.calls[0][1];
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(PANEL_USER_AGENT);
    expect(PANEL_USER_AGENT).toMatch(/^\S+\/\S+ \(https:\/\/\S+\)$/);
  });

  it.each([404, 429, 500, 503])("throws on HTTP %i", async (status) => {
    stubFetch(async () => jsonResponse({ error: true }, { status }));
    await expect(fetchCappedJson(URL_, { maxBytes: 1000 })).rejects.toBeInstanceOf(PanelFetchError);
  });

  it("throws on a network error", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchCappedJson(URL_, { maxBytes: 1000 })).rejects.toBeInstanceOf(PanelFetchError);
  });

  it("throws when the timeout signal fires, before or during the body", async () => {
    const timeouts: AbortController[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      timeouts.push(controller);
      return controller.signal;
    });
    const timeUp = () => timeouts.at(-1)!.abort(new DOMException("timed out", "TimeoutError"));

    try {
      stubFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
          })
      );
      const beforeHeaders = fetchCappedJson(URL_, { maxBytes: 1000 });
      timeUp();
      await expect(beforeHeaders).rejects.toBeInstanceOf(PanelFetchError);
      expect(timeoutSpy).toHaveBeenLastCalledWith(PANEL_TIMEOUT_MS);

      // Headers arrived, the body stalls: the same signal errors the stream.
      stubFetch(async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"a":'));
            init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason));
          },
        });
        return new Response(body, { status: 200 });
      });
      const duringBody = fetchCappedJson(URL_, { maxBytes: 1000 });
      await vi.waitFor(() => expect(timeouts).toHaveLength(2));
      timeUp();
      await expect(duringBody).rejects.toThrow(/body read failed/);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("refuses a body whose declared length is over the cap, without reading it", async () => {
    const body = streamOf(["{}"]);
    const cancel = vi.spyOn(body, "cancel");
    stubFetch(async () => new Response(body, { status: 200, headers: { "content-length": "5000" } }));
    await expect(fetchCappedJson(URL_, { maxBytes: 1000 })).rejects.toThrow(/over 1000 bytes/);
    expect(cancel).toHaveBeenCalled();
  });

  it("stops reading a body that grows past the cap with no declared length", async () => {
    stubFetch(async () => new Response(streamOf(['{"a":"', "x".repeat(600), "x".repeat(600), '"}']), { status: 200 }));
    await expect(fetchCappedJson(URL_, { maxBytes: 1000 })).rejects.toThrow(/over 1000 bytes/);
  });

  it("reads a body split across chunks", async () => {
    stubFetch(async () => new Response(streamOf(['{"a":', '"é"', "}"]), { status: 200 }));
    await expect(fetchCappedJson(URL_, { maxBytes: 1000 })).resolves.toEqual({ a: "é" });
  });

  it.each(["", "<html>error</html>", '{"truncated":'])("throws on a body that is not JSON: %j", async (text) => {
    stubFetch(async () => new Response(text, { status: 200 }));
    await expect(fetchCappedJson(URL_, { maxBytes: 1000 })).rejects.toBeInstanceOf(PanelFetchError);
  });
});
