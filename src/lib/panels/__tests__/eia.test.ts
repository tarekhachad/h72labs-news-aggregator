import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelFetchError } from "../fetchJson";
import { EIA_TIMEOUT_MS, eiaApiKey, fetchOilPrices, parseOilPrices } from "../eia";
import { jsonResponse } from "./fixtures";
import { eiaBody, eiaLatest } from "./ratesFixtures";

const KEY = "test-key-0123456789abcdef";

beforeEach(() => {
  vi.stubEnv("EIA_API_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseOilPrices", () => {
  it("reads each series' latest price from string values, ignoring the spurious row-count warning", () => {
    expect(parseOilPrices(eiaLatest)).toEqual({
      brent: { value: 125.44, date: "2026-10-06" },
      wti: { value: 96.24, date: "2026-10-06" },
    });
  });

  it("finds each series' own latest day when one series skips a holiday", () => {
    const body = eiaBody([
      { period: "2026-10-06", series: "RWTC", value: "96.24" },
      { period: "2026-10-05", series: "RWTC", value: "96.13" },
      { period: "2026-10-02", series: "RBRTE", value: "124.90" },
    ]);
    expect(parseOilPrices(body)).toEqual({
      brent: { value: 124.9, date: "2026-10-02" },
      wti: { value: 96.24, date: "2026-10-06" },
    });
  });

  it("accepts a numeric value, and a negative price (WTI traded below zero in 2020)", () => {
    const body = eiaBody([
      { period: "2020-04-20", series: "RWTC", value: "-36.98" },
      { period: "2020-04-20", series: "RBRTE", value: 25.57 },
    ]);
    expect(parseOilPrices(body)).toEqual({
      brent: { value: 25.57, date: "2020-04-20" },
      wti: { value: -36.98, date: "2020-04-20" },
    });
  });

  it("skips null, blank and non-numeric values, and leaves out a series with none", () => {
    const body = eiaBody([
      { period: "2026-10-07", series: "RWTC", value: null },
      { period: "2026-10-06", series: "RWTC", value: "NA" },
      { period: "2026-10-05", series: "RWTC", value: "" },
      { period: "2026-10-06", series: "RBRTE", value: "125.44" },
    ]);
    expect(parseOilPrices(body)).toEqual({ brent: { value: 125.44, date: "2026-10-06" }, wti: null });
  });

  it.each([
    ["no rows at all", eiaBody([])],
    ["only unusable rows", eiaBody([{ period: "2026-10-06", series: "RWTC", value: "1e9" }])],
    ["the bad-key error body", { error: { code: "API_KEY_INVALID", message: "An invalid api_key was supplied." } }],
    ["a body with no data array", { response: { total: "0" } }],
  ])("throws on %s", (_name, body) => {
    expect(() => parseOilPrices(body)).toThrow(PanelFetchError);
  });
});

describe("eiaApiKey", () => {
  it.each([
    ["unset", undefined, null],
    ["blank", "   ", null],
    ["set", ` ${KEY} `, KEY],
  ])("is null when %s", (_name, value, expected) => {
    vi.stubEnv("EIA_API_KEY", value);
    expect(eiaApiKey()).toBe(expected);
  });
});

describe("fetchOilPrices", () => {
  it("sends the key in a header, never in the URL", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () => jsonResponse(eiaLatest));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOilPrices()).resolves.toMatchObject({ brent: { value: 125.44 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(KEY);
    expect(url).not.toContain("api_key");
    expect(url).toContain("facets[series][]=RBRTE&facets[series][]=RWTC");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe(KEY);
    expect(timeout).toHaveBeenCalledWith(EIA_TIMEOUT_MS);
  });

  it.each([
    ["a rejected key", () => jsonResponse({ error: { code: "API_KEY_INVALID" } }, { status: 403 })],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("keeps the key out of the error on %s", async (_name, impl) => {
    vi.stubGlobal("fetch", vi.fn(async () => impl()));
    const error = await fetchOilPrices().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PanelFetchError);
    expect(String((error as Error).message)).not.toContain(KEY);
    expect(String((error as Error).cause ?? "")).not.toContain(KEY);
  });

  it("throws without a request when there is no key", async () => {
    vi.stubEnv("EIA_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchOilPrices()).rejects.toBeInstanceOf(PanelFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
