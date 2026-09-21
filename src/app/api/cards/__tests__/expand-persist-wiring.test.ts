import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// How the expand route caches a report now that `update own cards` is gone.
//
// The write is a best-effort cache fill, and that shapes every assertion here:
// by the time it runs the user already has their report in the response body,
// so neither a lost race nor an outright failure may turn a successful expand
// into an error. What must NOT happen is the opposite — a silent change to
// the arguments, which would leave every expand regenerating a report it had
// already paid for, at roughly a cent each, with nothing failing anywhere.

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
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

import { recordCall } from "@/lib/usageCollector";

const CARD_ID = "11111111-2222-4333-8444-555555555555";
const REPORT = "a full report";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

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

describe("expand route: caching the report", () => {
  it("sends the card id and the report, and nothing else", async () => {
    await runPost();

    expect(mocks.setExpandedReport).toHaveBeenCalledWith("set_expanded_report", {
      p_card_id: CARD_ID,
      p_report: REPORT,
    });
  });

  it("does not write anything when the report was already cached", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        id: CARD_ID,
        topic: "Tech/AI",
        short_summary: "a short summary",
        expanded_report: "cached",
        sources: [],
      },
      error: null,
    });

    const res = await runPost();

    expect(res.status).toBe(200);
    expect(mocks.setExpandedReport).not.toHaveBeenCalled();
  });

  it("still returns the report when another request cached its own first", async () => {
    // The function returns false when expanded_report is no longer null. That
    // is the first-writer-wins race resolving normally, not a failure: this
    // request generated a perfectly good report and the user gets it.
    mocks.setExpandedReport.mockResolvedValue({ data: false, error: null });

    const res = await runPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expandedReport: REPORT });
  });

  it("still returns the report when the write itself fails", async () => {
    mocks.setExpandedReport.mockResolvedValue({
      data: null,
      error: { message: "permission denied" },
    });

    const res = await runPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expandedReport: REPORT });
    expect(console.error).toHaveBeenCalled();
  });
});
