import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelFetchError } from "../fetchJson";
import { fetchExchangeRates, FRANKFURTER_TIMEOUT_MS, parsePair } from "../frankfurter";
import { jsonResponse } from "./fixtures";
import { frankfurterPair } from "./ratesFixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parsePair", () => {
  it("reads the rate and its day", () => {
    expect(parsePair(frankfurterPair("EUR", "USD", 1.1199, "2026-10-14"), "EUR", "USD")).toEqual({
      value: 1.1199,
      date: "2026-10-14",
    });
  });

  it.each([
    ["the pair the other way round", frankfurterPair("USD", "EUR", 0.89)],
    ["a zero rate", frankfurterPair("EUR", "USD", 0)],
    ["a negative rate", frankfurterPair("EUR", "USD", -1.1)],
    ["a rate sent as a string", { ...frankfurterPair("EUR", "USD", 1), rate: "1.1199" }],
    ["a day that does not exist", frankfurterPair("EUR", "USD", 1.1199, "2026-02-30")],
    ["the API's error body", { status: 422, message: "invalid currency: ABC" }],
    ["an array", [frankfurterPair("EUR", "USD", 1.1199)]],
  ])("throws on %s", (_name, body) => {
    expect(() => parsePair(body, "EUR", "USD")).toThrow(PanelFetchError);
  });
});

describe("fetchExchangeRates", () => {
  it("asks for each pair and returns both, each with its own day", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/EUR/USD")
        ? jsonResponse(frankfurterPair("EUR", "USD", 1.1199, "2026-10-14"))
        : jsonResponse(frankfurterPair("USD", "MAD", 9.7515, "2026-10-13"))
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchExchangeRates()).resolves.toEqual({
      eurUsd: { value: 1.1199, date: "2026-10-14" },
      usdMad: { value: 9.7515, date: "2026-10-13" },
    });
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
      "https://api.frankfurter.dev/v2/rate/EUR/USD",
      "https://api.frankfurter.dev/v2/rate/USD/MAD",
    ]);
    expect(timeout).toHaveBeenCalledWith(FRANKFURTER_TIMEOUT_MS);
  });

  it("throws when either pair fails, so a half answer is never cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/EUR/USD")
          ? jsonResponse(frankfurterPair("EUR", "USD", 1.1199))
          : jsonResponse({ status: 404, message: "not found" }, { status: 404 })
      )
    );
    await expect(fetchExchangeRates()).rejects.toBeInstanceOf(PanelFetchError);
  });
});
