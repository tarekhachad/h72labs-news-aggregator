import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, TOPICS } from "@/types";

// The card writer stores a card's sources preferred-first. The full report
// inherits that order only if the expand route hands the persisted list over
// as it is, with no re-sorting of its own; this pins that.

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

const CARD_ID = "11111111-2222-4333-8444-555555555555";

// Deliberately not in catalog or alphabetical order, so any sort would show.
const PERSISTED_SOURCES = [SOURCES[5], SOURCES[2], SOURCES[9], SOURCES[0]].map((source, i) => ({
  title: `Title ${i}`,
  url: `https://example.com/${i}`,
  source,
  snippet: `Snippet ${i}`,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.maybeSingle.mockResolvedValue({
    data: {
      id: CARD_ID,
      topic: TOPICS[0],
      short_summary: "a short summary",
      expanded_report: null,
      sources: PERSISTED_SOURCES,
    },
    error: null,
  });
  mocks.setExpandedReport.mockResolvedValue({ data: true, error: null });
  mocks.defaultUsageSinks.mockReturnValue([async () => {}]);
  mocks.generateExpandedReport.mockResolvedValue("a full report");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("expand route: source order", () => {
  it("passes the card's persisted sources to the report writer in their stored order", async () => {
    const { POST } = await import("@/app/api/cards/[id]/expand/route");
    await POST(new Request("http://localhost/api/cards/x/expand", { method: "POST" }), {
      params: Promise.resolve({ id: CARD_ID }),
    });

    expect(mocks.generateExpandedReport).toHaveBeenCalledTimes(1);
    expect(mocks.generateExpandedReport.mock.calls[0][0].sources).toEqual(PERSISTED_SOURCES);
  });
});
