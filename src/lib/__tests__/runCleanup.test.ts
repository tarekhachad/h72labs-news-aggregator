import { describe, it, expect, beforeEach, vi } from "vitest";
import { settleThenRelease, settleAbandonedRun } from "@/lib/runCleanup";
import type { Reservation } from "@/lib/spend";

// These two functions are the only cleanup after a digest run, and one of them
// covers a path no route-level test can reach: a request cancelled before the
// stream's first pull. Constructing the stream triggers that pull before the
// caller can get the response back, so the route cannot be driven into it.
// That is why the amount lives in the module rather than at the call site --
// here it can be held to account.

const mocks = vi.hoisted(() => ({
  settleSpend: vi.fn(),
  releaseGenerationClaim: vi.fn(),
}));

vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return { ...actual, settleSpend: mocks.settleSpend };
});
vi.mock("@/lib/generationClaim", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/generationClaim")>("@/lib/generationClaim");
  return { ...actual, releaseGenerationClaim: mocks.releaseGenerationClaim };
});

const RESERVATION: Reservation = { id: "reservation-id", token: "settle-token", reservedUsd: 0.7 };
const CLAIM = { claimId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const SUPABASE = {} as never;

let order: string[];

beforeEach(() => {
  order = [];
  mocks.settleSpend.mockReset().mockImplementation(async () => {
    order.push("settle");
    return true;
  });
  mocks.releaseGenerationClaim.mockReset().mockImplementation(async () => {
    order.push("release");
  });
});

describe("settleThenRelease", () => {
  it("settles the reservation before releasing the claim", async () => {
    await settleThenRelease(SUPABASE, RESERVATION, CLAIM, 0.23);

    expect(mocks.settleSpend).toHaveBeenCalledWith(RESERVATION, 0.23);
    expect(mocks.releaseGenerationClaim).toHaveBeenCalledWith(SUPABASE, CLAIM);
    // Not interchangeable: a release waiting behind an unbounded settle could
    // strand the claim for the whole staleness window.
    expect(order).toEqual(["settle", "release"]);
  });

  it("passes a null amount through, so a run with no cost record keeps its reservation", async () => {
    await settleThenRelease(SUPABASE, RESERVATION, CLAIM, null);

    expect(mocks.settleSpend).toHaveBeenCalledWith(RESERVATION, null);
  });

  it("releases the claim even when the settle reports failure", async () => {
    mocks.settleSpend.mockResolvedValue(false);

    await settleThenRelease(SUPABASE, RESERVATION, CLAIM, 0.1);

    // A failed settle must not cost the user their claim for three minutes on
    // top of whatever went wrong with the settle.
    expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(1);
  });
});

describe("settleAbandonedRun", () => {
  // The assertion this module exists for. A request abandoned before the
  // pipeline started made no Claude call, so charging it anything would bill a
  // user for work never done -- up to the full worst-case reservation.
  it("settles at exactly zero, never the reserved amount", async () => {
    await settleAbandonedRun(SUPABASE, RESERVATION, CLAIM);

    expect(mocks.settleSpend).toHaveBeenCalledWith(RESERVATION, 0);
    const [, amount] = mocks.settleSpend.mock.calls[0];
    expect(amount).toBe(0);
    expect(amount).not.toBe(RESERVATION.reservedUsd);
  });

  it("still releases the claim, in the same order", async () => {
    await settleAbandonedRun(SUPABASE, RESERVATION, CLAIM);

    expect(mocks.releaseGenerationClaim).toHaveBeenCalledWith(SUPABASE, CLAIM);
    expect(order).toEqual(["settle", "release"]);
  });
});
