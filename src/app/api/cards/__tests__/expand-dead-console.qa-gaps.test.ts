import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// QA round 1 gap: the expand route's "failed to write this run's cost record"
// catch sits in a finally; with a dead console its log line would escape that
// finally and replace the paid 200 with a thrown error.
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), maybeSingle: vi.fn(), setExpandedReport: vi.fn(),
  generateExpandedReport: vi.fn(), defaultUsageSinks: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.setExpandedReport,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }),
  })),
}));
vi.mock("@/lib/cards", () => ({ generateExpandedReport: mocks.generateExpandedReport }));
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return { ...actual,
    reserveSpend: vi.fn(async () => ({ status: "ok", reservation: { id: "reservation-1", token: "t".repeat(64), reservedUsd: 0.12 } })),
    settleSpend: vi.fn(async () => true) };
});
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

import { recordCall } from "@/lib/usageCollector";
import { settleSpend } from "@/lib/spend";

const CARD_ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {
      throw new Error("console is dead");
    });
  }
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.maybeSingle.mockResolvedValue({
    data: { id: CARD_ID, topic: "Tech/AI", short_summary: "s", expanded_report: null, sources: [] },
    error: null,
  });
  mocks.setExpandedReport.mockResolvedValue({ data: true, error: null });
  mocks.generateExpandedReport.mockImplementation(async () => {
    await recordCall("expand", "claude-sonnet-5", async () => ({
      usage: { input_tokens: 2000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
    return "a full report";
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("expand route with a dead console (QA gaps)", () => {
  it("returns the paid report when building the cost sinks throws", async () => {
    mocks.defaultUsageSinks.mockImplementation(() => {
      throw new Error("sinks broke");
    });
    const { POST } = await import("@/app/api/cards/[id]/expand/route");
    const res = await POST(new Request("http://localhost/api/cards/x/expand", { method: "POST" }), {
      params: Promise.resolve({ id: CARD_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expandedReport: "a full report" });
    expect(settleSpend).toHaveBeenCalledTimes(1);
  });
});
