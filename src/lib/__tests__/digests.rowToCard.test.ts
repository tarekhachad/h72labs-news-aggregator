import { describe, it, expect } from "vitest";
import { rowToCard, type CardRow } from "@/lib/digests";

function makeRow(overrides: Partial<CardRow> = {}): CardRow {
  return {
    id: "card-1",
    topic: "Tech/AI",
    short_summary: "summary",
    expanded_report: null,
    sources: [],
    published_at: "2026-08-01T00:00:00Z",
    created_at: "2026-08-01T00:05:00Z",
    severity: null,
    front_page_rank: null,
    ...overrides,
  };
}

describe("rowToCard: severity/frontPageRank mapping", () => {
  it("defaults a null severity (row persisted before the column existed) to 1", () => {
    const card = rowToCard(makeRow({ severity: null }), new Set());
    expect(card.severity).toBe(1);
  });

  it("passes through a real severity value unchanged", () => {
    const card = rowToCard(makeRow({ severity: 4 }), new Set());
    expect(card.severity).toBe(4);
  });

  it("does NOT default a null front_page_rank to 1 -- null means 'not on the front page', not 'unknown'", () => {
    const card = rowToCard(makeRow({ front_page_rank: null }), new Set());
    expect(card.frontPageRank).toBeNull();
  });

  it("passes through a real front_page_rank value unchanged", () => {
    const card = rowToCard(makeRow({ front_page_rank: 3 }), new Set());
    expect(card.frontPageRank).toBe(3);
  });

  it("treats severity 0 as falsy-but-valid input distinctly from null (defensive: ?? not ||)", () => {
    // severity is DB-constrained to be graded 1-5 by the write path, but the
    // mapper itself uses `??` (nullish coalescing), not `||` -- this guards
    // against a future 0-is-valid value silently being coerced to 1 the way
    // `||` would. Documents the intentional operator choice.
    const card = rowToCard(makeRow({ severity: 0 as unknown as number }), new Set());
    expect(card.severity).toBe(0);
  });
});
