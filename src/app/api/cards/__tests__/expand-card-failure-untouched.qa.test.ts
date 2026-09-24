import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GenerationRejectedError } from "@/lib/claudeText";

// The expand route shares generateWithRetryOnAmbiguousTruncation with
// writeCard, but it does NOT classify failures into cardFailures -- its
// catch is generic (see route.ts's `catch (err)` around
// generateExpandedReport), and its usage-run record hardcodes
// cardFailures/triageFailedClosed to null, same as every other
// digest-shaped field an expand run never measures. These pin that a
// GenerationRejectedError specifically (not just a generic Error) still:
//   1. produces the same 502 response and message as before this change, and
//   2. leaves cardFailures/triageFailedClosed null rather than somehow
//      picking up a value, which would misreport an expand run as having
//      gone through the digest pipeline's card-loss accounting.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  setExpandedReport: vi.fn(),
  generateExpandedReport: vi.fn(),
  defaultUsageSinks: vi.fn(),
}));

vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({
      status: "ok",
      reservation: { id: "reservation-id", token: "settle-token", reservedUsd: 0.7 },
    })),
    settleSpend: vi.fn(async () => true),
  };
});

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

vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

import type { UsageRunRecord } from "@/lib/usageRecord";

const CARD_ID = "11111111-2222-4333-8444-555555555555";

const CARD_ROW = {
  id: CARD_ID,
  topic: "Tech/AI",
  short_summary: "a short summary",
  expanded_report: null,
  sources: [],
};

let emitted: UsageRunRecord[];

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
  mocks.maybeSingle.mockResolvedValue({ data: CARD_ROW, error: null });
  mocks.setExpandedReport.mockResolvedValue({ data: true, error: null });
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

describe("expand route: unaffected by the card-failure classification added elsewhere", () => {
  it("still 502s with the same message when the shared retry helper rejects with a GenerationRejectedError", async () => {
    mocks.generateExpandedReport.mockRejectedValue(
      new GenerationRejectedError(
        "generateExpandedReport produced empty output (stop_reason: end_turn)",
        "empty",
        "end_turn",
        ""
      )
    );

    const res = await runPost();
    const body = await res.text();

    expect(res.status).toBe(502);
    expect(body).toBe("Couldn't generate the full report — try again.");
  });

  it("leaves cardFailures and triageFailedClosed null on that same 502, not populated from the rejection", async () => {
    mocks.generateExpandedReport.mockRejectedValue(
      new GenerationRejectedError("m", "truncated", "max_tokens", "cut off mid")
    );

    await runPost();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].cardFailures).toBeNull();
    expect(emitted[0].triageFailedClosed).toBeNull();
    expect(emitted[0].cardsFailed).toBeNull();
  });

  it("leaves cardFailures and triageFailedClosed null on a clean generation too", async () => {
    mocks.generateExpandedReport.mockResolvedValue("a full report");

    await runPost();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].cardFailures).toBeNull();
    expect(emitted[0].triageFailedClosed).toBeNull();
  });
});
