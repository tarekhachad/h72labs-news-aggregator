import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster } from "@/types";
import { isFailClosed } from "@/lib/triageOutcome";

// Triage also returns one English sentence on what happened, for notable
// clusters only, so the duplicate check can compare stories across topics and
// languages. The sentence must never decide whether a cluster is kept.

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function cluster(title: string): Cluster {
  return {
    topic: "Tech/AI",
    articles: [
      { title, snippet: "s", url: `https://example.com/${title}`, source: "BBC", topic: "Tech/AI", publishedAt: "2026-10-03T12:00:00Z" },
    ],
  };
}

type Verdict = { index: number; notable: boolean; severity: number; event?: string };
const respond = (verdicts: Verdict[]) => mockParse.mockResolvedValue({ parsed_output: { verdicts } });

beforeEach(() => {
  mockParse.mockReset();
  delete process.env.TRIAGE_REASONS;
});

describe("triage event sentence", () => {
  it("returns the trimmed sentence on a notable verdict", async () => {
    respond([{ index: 0, notable: true, severity: 3, event: "  OpenAI released a new model in San Francisco.  " }]);
    const { triageClusters } = await import("@/lib/triage");

    const [outcome] = await triageClusters([cluster("a")]);

    expect(outcome).toEqual({ notable: true, severity: 3, event: "OpenAI released a new model in San Francisco." });
  });

  it("drops a sentence the model gave for a rejected cluster", async () => {
    respond([{ index: 0, notable: false, severity: 1, event: "Something minor happened." }]);
    const { triageClusters } = await import("@/lib/triage");

    const [outcome] = await triageClusters([cluster("a")]);

    expect(outcome).toEqual({ notable: false, severity: 1 });
  });

  it("keeps a notable cluster with no sentence, or an empty one, without an event", async () => {
    respond([
      { index: 0, notable: true, severity: 4 },
      { index: 1, notable: true, severity: 2, event: "   " },
    ]);
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters([cluster("a"), cluster("b")]);

    expect(outcomes).toEqual([
      { notable: true, severity: 4 },
      { notable: true, severity: 2 },
    ]);
    expect("event" in outcomes[0]).toBe(false);
  });

  it("still fails an unjudged cluster closed, as the shared singleton", async () => {
    mockParse.mockResolvedValueOnce({ parsed_output: { verdicts: [{ index: 0, notable: true, severity: 3, event: "A happened." }] } });
    mockParse.mockRejectedValue(new Error("down"));
    const { triageClusters } = await import("@/lib/triage");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Index 1 is never answered and its retries fail, so it fails closed.
    const outcomes = await triageClusters([cluster("a"), cluster("b")]);

    expect(outcomes[0]).toEqual({ notable: true, severity: 3, event: "A happened." });
    expect(isFailClosed(outcomes[1])).toBe(true);
  });

  it("asks for an English event sentence for notable clusters only, in both modes, leaving the calibration prompt intact", async () => {
    respond([{ index: 0, notable: false, severity: 1 }]);
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters([cluster("a")]);
    process.env.TRIAGE_REASONS = "1";
    await triageClusters([cluster("a")]);

    for (const call of mockParse.mock.calls) {
      const system = call[0].system as string;
      expect(system).toContain('For each cluster you judge notable, also give "event"');
      expect(system).toContain("in English even when the articles are in another language");
      expect(system).toContain('Leave "event" out for clusters you reject.');
      expect(system).toContain("typical-day baseline");
    }
  });

  it("sizes the output ceilings for a batch where every cluster is notable and carries a sentence", async () => {
    respond([{ index: 0, notable: false, severity: 1 }]);
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters([cluster("a")]);
    process.env.TRIAGE_REASONS = "1";
    await triageClusters([cluster("a")]);

    expect(mockParse.mock.calls.map((c) => c[0].max_tokens)).toEqual([2048, 3072]);
  });

  it("declares the event as an optional string in the output schema", async () => {
    respond([{ index: 0, notable: false, severity: 1 }]);
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters([cluster("a")]);

    const schema = mockParse.mock.calls[0][0].output_config.format.schema;
    const item = schema.properties.verdicts.items;
    expect(item.properties.event).toEqual({ type: "string" });
    expect(item.required).not.toContain("event");
  });
});
