import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A full report is paid for before any of the route's log lines run, so a
// console that throws must not decide what the reader gets back or whether
// the reservation is settled.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  setExpandedReport: vi.fn(),
  generateExpandedReport: vi.fn(),
  defaultUsageSinks: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.setExpandedReport,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }),
    }),
  })),
}));
vi.mock("@/lib/cards", () => ({ generateExpandedReport: mocks.generateExpandedReport }));
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({
      status: "ok",
      reservation: { id: "reservation-1", token: "t".repeat(64), reservedUsd: 0.12 },
    })),
    settleSpend: vi.fn(async () => true),
  };
});
vi.mock("@/lib/usageRecord", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageRecord")>("@/lib/usageRecord");
  return { ...actual, buildUsageRunRecord: vi.fn(actual.buildUsageRunRecord) };
});
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

import { recordCall } from "@/lib/usageCollector";
import { buildUsageRunRecord } from "@/lib/usageRecord";
import { settleSpend } from "@/lib/spend";

const CARD_ID = "11111111-2222-4333-8444-555555555555";
const REPORT = "a full report";

beforeEach(() => {
  vi.clearAllMocks();
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {
      throw new Error("console is dead");
    });
  }

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.maybeSingle.mockResolvedValue({
    data: {
      id: CARD_ID,
      topic: "Tech/AI",
      short_summary: "a short summary",
      expanded_report: null,
      sources: [],
    },
    error: null,
  });
  mocks.setExpandedReport.mockResolvedValue({ data: true, error: null });
  mocks.defaultUsageSinks.mockReturnValue([async () => {}]);
  mocks.generateExpandedReport.mockImplementation(async () => {
    await recordCall("expand", "claude-sonnet-5", async () => ({
      usage: {
        input_tokens: 2000,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }));
    return REPORT;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runPost() {
  const { POST } = await import("@/app/api/cards/[id]/expand/route");
  return POST(new Request("http://localhost/api/cards/x/expand", { method: "POST" }), {
    params: Promise.resolve({ id: CARD_ID }),
  });
}

describe("expand route with a dead console", () => {
  it("returns the paid report when caching it fails", async () => {
    mocks.setExpandedReport.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    const res = await runPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expandedReport: REPORT });
    expect(settleSpend).toHaveBeenCalledTimes(1);
  });

  it("returns the report and keeps the full reservation when the cost record can't be built", async () => {
    vi.mocked(buildUsageRunRecord).mockImplementationOnce(() => {
      throw new Error("record broke");
    });

    const res = await runPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expandedReport: REPORT });
    expect(settleSpend).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("still answers a failed generation with a 502", async () => {
    mocks.generateExpandedReport.mockRejectedValue(new Error("model error"));

    const res = await runPost();

    expect(res.status).toBe(502);
    expect(settleSpend).toHaveBeenCalledTimes(1);
  });
});
