import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Reservation } from "@/lib/spend";

// The expand route's side of the spend cap: a cached report is free and
// never reserves, a refusal never calls Claude, and a generation that fails
// still settles what it spent.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  updateIs: vi.fn(),
  generateExpandedReport: vi.fn(),
  defaultUsageSinks: vi.fn(),
  reserveSpend: vi.fn(),
  settleSpend: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }),
      update: () => ({ eq: () => ({ is: mocks.updateIs }) }),
    }),
  })),
}));
vi.mock("@/lib/cards", () => ({ generateExpandedReport: mocks.generateExpandedReport }));
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return { ...actual, reserveSpend: mocks.reserveSpend, settleSpend: mocks.settleSpend };
});

import { recordCall } from "@/lib/usageCollector";

const CARD_ID = "11111111-2222-4333-8444-555555555555";
const CARD_ROW = {
  id: CARD_ID,
  topic: "Tech/AI",
  short_summary: "a short summary",
  expanded_report: null,
  sources: [],
};
const RESERVATION: Reservation = { id: "reservation-1", token: "t".repeat(64), reservedUsd: 0.12 };

let order: string[];

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.maybeSingle.mockResolvedValue({ data: CARD_ROW, error: null });
  mocks.updateIs.mockResolvedValue({ error: null });
  mocks.defaultUsageSinks.mockReturnValue([
    async () => {
      order.push("emit");
    },
  ]);
  mocks.reserveSpend.mockResolvedValue({ status: "ok", reservation: RESERVATION });
  mocks.settleSpend.mockImplementation(async () => {
    order.push("settle");
    return true;
  });
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

async function runPost() {
  const { POST } = await import("@/app/api/cards/[id]/expand/route");
  return POST(new Request("http://localhost/api/cards/x/expand", { method: "POST" }), {
    params: Promise.resolve({ id: CARD_ID }),
  });
}

describe("expand route: spend caps", () => {
  it("serves a cached report without reserving", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { ...CARD_ROW, expanded_report: "cached" }, error: null });

    const res = await runPost();

    expect(res.status).toBe(200);
    expect(mocks.reserveSpend).not.toHaveBeenCalled();
    expect(mocks.settleSpend).not.toHaveBeenCalled();
  });

  it("reserves an expand on a cache miss and settles it to the billed total before the record", async () => {
    const res = await runPost();

    expect(res.status).toBe(200);
    expect(mocks.reserveSpend).toHaveBeenCalledWith(expect.anything(), "expand", {
      ref: CARD_ID,
      keepAlive: expect.any(Function),
    });
    const [reservation, amount] = mocks.settleSpend.mock.calls[0];
    expect(reservation).toEqual(RESERVATION);
    expect(amount).toBeGreaterThan(0);
    expect(order).toEqual(["settle", "emit"]);
  });

  it("refuses at a limit with 429 and never calls Claude", async () => {
    mocks.reserveSpend.mockResolvedValue({
      status: "refused",
      reason: "user_count",
      availableAt: "2026-09-18T17:00:00.000Z",
    });

    const res = await runPost();

    expect(res.status).toBe(429);
    expect((await res.json()).message).toBe("You've reached your limit of full reports for now.");
    expect(mocks.generateExpandedReport).not.toHaveBeenCalled();
    expect(mocks.settleSpend).not.toHaveBeenCalled();
  });

  it.each([
    ["the kill switch", { status: "refused", reason: "disabled", availableAt: null }],
    ["a failed check", { status: "error" }],
  ])("answers %s with 503 and never calls Claude", async (_label, result) => {
    mocks.reserveSpend.mockResolvedValue(result);

    const res = await runPost();

    expect(res.status).toBe(503);
    expect(mocks.generateExpandedReport).not.toHaveBeenCalled();
  });

  it("still settles when the generation fails and the route answers 502", async () => {
    mocks.generateExpandedReport.mockImplementation(async () => {
      await recordCall("expand", "claude-sonnet-5", async () => ({
        usage: { input_tokens: 2000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }));
      throw new Error("bad structured output");
    });

    const res = await runPost();

    expect(res.status).toBe(502);
    expect(mocks.settleSpend).toHaveBeenCalledTimes(1);
    expect(mocks.settleSpend.mock.calls[0][1]).toBeGreaterThan(0);
  });

  it("does not reserve for a card the user cannot see", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await runPost();
    expect(res.status).toBe(404);
    expect(mocks.reserveSpend).not.toHaveBeenCalled();
  });
});
