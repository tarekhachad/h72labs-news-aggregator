import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Reservation } from "@/lib/spend";
import { summarizeUsage } from "@/lib/usage";

// QA (v2.4-fair-settle). The expand route's side of the fair settle.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  setExpandedReport: vi.fn(),
  generateExpandedReport: vi.fn(),
  defaultUsageSinks: vi.fn(),
  reserveSpend: vi.fn(),
  settleSpend: vi.fn(),
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
// Sized so three attempts still fit under the 0.12 hold. At the real expand
// max_tokens (4096), three Sonnet attempts exceed it and the settle is capped.
const BOUND = { requestBytes: 3000, maxOutputTokens: 1024, attempts: 3 };

let order: string[];

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.maybeSingle.mockResolvedValue({ data: CARD_ROW, error: null });
  mocks.setExpandedReport.mockResolvedValue({ data: true, error: null });
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


describe("expand route: fair settle of a floor run", () => {
  it("settles a measured attempt plus a failed retry at the proven ceiling, below the reservation", async () => {
    mocks.generateExpandedReport.mockImplementation(async () => {
      await recordCall("expand", "claude-sonnet-5", async () => ({
        usage: { input_tokens: 2000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }), BOUND);
      await recordCall("expand", "claude-sonnet-5", async () => {
        throw new Error("socket hang up");
      }, BOUND);
      return "unreachable";
    });

    await runPost();

    const s = summarizeUsage(
      [
        { stage: "expand", model: "claude-sonnet-5", tokens: { inputTokens: 2000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        { stage: "expand", model: "claude-sonnet-5", tokens: null, bound: BOUND },
      ],
      new Date()
    );
    const amount = mocks.settleSpend.mock.calls[0][1] as number;
    expect(amount).toBeCloseTo(s.totalBilledUsd + s.unmeasuredBoundUsd!, 12);
    expect(amount).toBeLessThan(RESERVATION.reservedUsd);
  });

  it("caps the settle at the reservation when the ceiling is above it", async () => {
    const huge = { requestBytes: 500_000, maxOutputTokens: 64_000, attempts: 3 };
    mocks.generateExpandedReport.mockImplementation(async () => {
      await recordCall("expand", "claude-sonnet-5", async () => {
        throw new Error("socket hang up");
      }, huge);
      return "x";
    });

    await runPost();

    expect(mocks.settleSpend.mock.calls[0][1]).toBe(RESERVATION.reservedUsd);
  });

  it("keeps the reservation for an unbounded usage-less call", async () => {
    mocks.generateExpandedReport.mockImplementation(async () => {
      await recordCall("expand", "claude-sonnet-5", async () => ({}));
      return "x";
    });

    await runPost();

    expect(mocks.settleSpend.mock.calls[0][1]).toBe(RESERVATION.reservedUsd);
  });

  it("caps at the reservation when only the attempt multiplier pushes the ceiling over it", async () => {
    // One attempt of this bound fits under the reservation; three don't.
    const b = { requestBytes: 8000, maxOutputTokens: 2048 };
    const single = summarizeUsage([{ stage: "expand", model: "claude-sonnet-5", tokens: null, bound: { ...b, attempts: 1 } }], new Date()).unmeasuredBoundUsd!;
    expect(single).toBeLessThan(RESERVATION.reservedUsd);
    expect(3 * single).toBeGreaterThan(RESERVATION.reservedUsd);
    mocks.generateExpandedReport.mockImplementation(async () => {
      await recordCall("expand", "claude-sonnet-5", async () => {
        throw new Error("socket hang up");
      }, { ...b, attempts: 3 });
      return "x";
    });

    await runPost();

    expect(mocks.settleSpend.mock.calls[0][1]).toBe(RESERVATION.reservedUsd);
  });

  it("at the real expand size (max_tokens 4096, three attempts) the ceiling exceeds the hold, so the settle stays at the reservation", async () => {
    const real = { requestBytes: 3000, maxOutputTokens: 4096, attempts: 3 };
    mocks.generateExpandedReport.mockImplementation(async () => {
      await recordCall("expand", "claude-sonnet-5", async () => {
        throw new Error("socket hang up");
      }, real);
      return "x";
    });
    await runPost();
    const s = summarizeUsage([{ stage: "expand", model: "claude-sonnet-5", tokens: null, bound: real }], new Date());
    expect(s.unmeasuredBoundUsd!).toBeGreaterThan(RESERVATION.reservedUsd);
    expect(mocks.settleSpend.mock.calls[0][1]).toBe(RESERVATION.reservedUsd);
  });
});
