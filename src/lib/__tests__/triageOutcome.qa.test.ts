import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster, Topic } from "@/types";
import { FAIL_CLOSED, isFailClosed } from "@/lib/triageOutcome";

// isFailClosed distinguishes "triage never judged this cluster" from "triage
// judged it and rejected it" purely by REFERENCE IDENTITY to the shared
// FAIL_CLOSED singleton -- the two carry identical fields ({notable: false,
// severity: 1}), so a struct-equality check would count both as fail-closed.
// These adversarially probe that identity survives the real triageClusters
// pipeline (not a test double that hands FAIL_CLOSED back by hand) and that
// isFailClosed itself only trusts identity, not shape.

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function makeCluster(topic: Topic, title: string): Cluster {
  return {
    topic,
    articles: [
      {
        title,
        snippet: "A snippet",
        url: `https://example.com/${title}`,
        source: "BBC",
        topic,
        publishedAt: "2026-09-24T12:00:00Z",
      },
    ],
  };
}

beforeEach(() => {
  mockParse.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("isFailClosed: identity, not shape", () => {
  it("is false for a judged-not-notable verdict with the exact same fields as FAIL_CLOSED", () => {
    // {notable: false, severity: 1} is a value a real judged rejection can
    // legitimately carry -- reason grading says "reject, severity doesn't
    // matter, return 1". A struct-equality bug would misreport a real
    // judgement as an unjudged fail-closed cluster.
    const copy = { notable: false, severity: 1 };
    expect(copy).toEqual(FAIL_CLOSED);
    expect(isFailClosed(copy)).toBe(false);
  });

  it("is true for the literal singleton and nothing else, even a fresh Object.freeze of the same shape", () => {
    expect(isFailClosed(FAIL_CLOSED)).toBe(true);
    expect(isFailClosed(Object.freeze({ notable: false, severity: 1 }))).toBe(false);
  });

  it("real triageClusters hands back the actual FAIL_CLOSED reference for an unjudged cluster, not a copy", async () => {
    // Every parse attempt returns nothing usable, so the whole split-retry
    // ladder bottoms out and triageClusters falls back to FAIL_CLOSED at its
    // final `clusters.map((_, i) => merged.get(i) ?? FAIL_CLOSED)`.
    mockParse.mockRejectedValue(new Error("always fails"));
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters([makeCluster("Tech/AI", "a")]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toBe(FAIL_CLOSED);
    expect(isFailClosed(outcomes[0])).toBe(true);
  });

  it("real triageClusters hands back a genuinely distinct object for a judged not-notable verdict at severity 1", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { verdicts: [{ index: 0, notable: false, severity: 1 }] },
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters([makeCluster("Tech/AI", "a")]);

    expect(outcomes[0]).toEqual({ notable: false, severity: 1 });
    expect(outcomes[0]).not.toBe(FAIL_CLOSED);
    expect(isFailClosed(outcomes[0])).toBe(false);
  });

  it("a mixed batch of unjudged and judged-not-notable clusters is counted correctly by outcomes.filter(isFailClosed)", async () => {
    // 3 clusters: [0] judged notable, [1] out-of-range index (unjudged ->
    // fail-closed), [2] judged not-notable at severity 1 (structurally
    // identical to FAIL_CLOSED but a real judgement).
    let call = 0;
    mockParse.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return {
          parsed_output: {
            verdicts: [
              { index: 0, notable: true, severity: 4 },
              { index: 999, notable: true, severity: 5 },
              { index: 2, notable: false, severity: 1 },
            ],
          },
        };
      }
      // Retry of the unjudged slot [1]: still nothing usable.
      return { parsed_output: { verdicts: [] } };
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters([
      makeCluster("Tech/AI", "a"),
      makeCluster("Tech/AI", "b"),
      makeCluster("Tech/AI", "c"),
    ]);

    expect(outcomes.filter(isFailClosed)).toHaveLength(1);
    expect(isFailClosed(outcomes[0])).toBe(false); // judged notable
    expect(isFailClosed(outcomes[1])).toBe(true); // genuinely unjudged
    expect(isFailClosed(outcomes[2])).toBe(false); // judged, just rejected
  });
});
