import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Drives the REAL expand route POST handler, the counterpart to
// usage-wiring.test.ts for the digest route.
//
// The specific thing worth pinning: the collector is created AFTER the
// cached-report early return, so a cache hit — the common case, since most
// expands read a report generated earlier — costs nothing and prints
// nothing. Nothing but ordering enforces that. If a future edit moved the
// early return below `createUsageCollector`, every cache hit would start
// printing "expand complete — 0 calls", quietly turning a free read into a
// line that looks like billed activity in the cost log.
//
// Also pins the 502 path, where a generation was billed and then failed —
// spend that no user-facing response mentions.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  updateIs: vi.fn(),
  generateExpandedReport: vi.fn(),
  defaultUsageSinks: vi.fn(),
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

// Only the sink LIST is swapped; emitUsageRun stays real, so its "never
// rejects, never hangs" guarantee is exercised here rather than mocked away.
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

import { recordCall } from "@/lib/usageCollector";
import type { UsageRunRecord } from "@/lib/usageRecord";

const CARD_ID = "11111111-2222-4333-8444-555555555555";

const CARD_ROW = {
  id: CARD_ID,
  topic: "Tech/AI",
  short_summary: "a short summary",
  expanded_report: null,
  sources: [],
};

function usage(inputTokens: number) {
  return {
    input_tokens: inputTokens,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

let logLines: string[];
let emitted: UsageRunRecord[];

beforeEach(() => {
  vi.clearAllMocks();
  logLines = [];
  emitted = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line === "string") logLines.push(line);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
  mocks.maybeSingle.mockResolvedValue({ data: CARD_ROW, error: null });
  mocks.updateIs.mockResolvedValue({ error: null });
  mocks.generateExpandedReport.mockImplementation(async () => {
    await recordCall("expand", "claude-sonnet-5", async () => ({ usage: usage(2000) }));
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

function usageLines() {
  return logLines.filter((line) => line.startsWith("[usage]"));
}

function summaryHeaders() {
  return usageLines().filter((line) => /expand (complete|failed)/.test(line));
}

describe("expand route: cost instrumentation", () => {
  it("records the Sonnet call and emits exactly one summary on a cache miss", async () => {
    const res = await runPost();

    expect(res.status).toBe(200);
    expect(summaryHeaders()).toHaveLength(1);
    const text = usageLines().join("\n");
    expect(text).toContain("expand complete — 1 calls");
    expect(text).toContain("claude-sonnet-5");
    expect(text).not.toContain("FLOOR");
  });

  it("prints nothing at all when the report was already cached", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { ...CARD_ROW, expanded_report: "already generated" },
      error: null,
    });

    const res = await runPost();

    expect(res.status).toBe(200);
    expect(mocks.generateExpandedReport).not.toHaveBeenCalled();
    // A free read must not look like billed activity in the cost log.
    expect(usageLines()).toEqual([]);
  });

  it("prints nothing for a cached empty-string report either", async () => {
    // "" is a real generated value here, not a miss — the route checks
    // against null precisely so it doesn't re-pay for this card forever.
    mocks.maybeSingle.mockResolvedValue({
      data: { ...CARD_ROW, expanded_report: "" },
      error: null,
    });

    await runPost();

    expect(mocks.generateExpandedReport).not.toHaveBeenCalled();
    expect(usageLines()).toEqual([]);
  });

  it("still reports the spend when generation fails and the user gets a 502", async () => {
    mocks.generateExpandedReport.mockImplementation(async () => {
      await recordCall("expand", "claude-sonnet-5", async () => ({ usage: usage(2000) }));
      throw new Error("model unavailable");
    });

    const res = await runPost();

    expect(res.status).toBe(502);
    expect(summaryHeaders()).toHaveLength(1);
    // Labelled by what happened, not optimistically.
    expect(usageLines().join("\n")).toContain("expand failed");
  });

  it("warns that the total is a floor when the billed call reported no usage", async () => {
    mocks.generateExpandedReport.mockImplementation(async () => {
      await recordCall("expand", "claude-sonnet-5", async () => ({}));
      return "a full report";
    });

    await runPost();

    expect(usageLines().join("\n")).toContain("FLOOR");
  });

  it("warns loudly if a report is produced without any recorded call", async () => {
    // The instrumentation-is-broken alarm for this route.
    mocks.generateExpandedReport.mockResolvedValue("a full report");

    await runPost();

    const text = usageLines().join("\n");
    expect(text).toContain("WARNING");
    expect(text).toContain("Instrumentation is not wired up");
  });

  it("keeps two concurrent expands from merging their spend", async () => {
    mocks.generateExpandedReport.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await recordCall("expand", "claude-sonnet-5", async () => ({ usage: usage(2000) }));
      return "a full report";
    });

    await Promise.all([runPost(), runPost()]);

    // Two runs, two summaries, each reporting its own single call.
    expect(summaryHeaders()).toHaveLength(2);
    for (const header of summaryHeaders()) {
      expect(header).toContain("1 calls");
    }
  });

  it("does not let a reporting failure change the response", async () => {
    vi.mocked(console.log).mockImplementation(() => {
      throw new Error("console exploded");
    });

    const res = await runPost();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ expandedReport: "a full report" });
  });
});

describe("expand route: the run is recorded durably", () => {
  it("emits exactly one record on a cache miss, identified by card rather than digest", async () => {
    await runPost();

    expect(emitted).toHaveLength(1);
    const record = emitted[0];
    expect(record.route).toBe("expand");
    expect(record.userId).toBe("user-1");
    expect(record.cardId).toBe(CARD_ID);
    expect(record.digestId).toBeNull();
    expect(record.outcome).toBe("complete");
    expect(record.label).toBe("expand complete");
    expect(record.totalBilledUsd).toBeGreaterThan(0);
  });

  it("records every digest-shaped field as null rather than zero", async () => {
    // An expand has no articles, no clusters and no ranking pass. Zero would
    // assert a measurement that was never taken, and would pull the mean of
    // "articles per run" toward nothing.
    await runPost();

    const record = emitted[0];
    expect(record.articleCount).toBeNull();
    expect(record.clusterCount).toBeNull();
    expect(record.clustersAfterDedup).toBeNull();
    expect(record.notableCount).toBeNull();
    expect(record.cardsDroppedByCap).toBeNull();
    expect(record.cardsWritten).toBeNull();
    expect(record.cardsFailed).toBeNull();
    expect(record.rankApplied).toBeNull();
    expect(record.topicCount).toBeNull();
    expect(record.sourceCount).toBeNull();
    expect(record.runShape).toBe("unknown");
  });

  it("writes NO record when the report was already cached", async () => {
    // The counterpart to printing nothing: a free read must not appear in the
    // durable record either, or the cost-per-expand mean gets divided by a
    // denominator full of runs that never called Claude.
    mocks.maybeSingle.mockResolvedValue({
      data: { ...CARD_ROW, expanded_report: "already generated" },
      error: null,
    });

    await runPost();

    expect(emitted).toEqual([]);
  });

  it("records the spend when generation fails and the user gets a 502", async () => {
    mocks.generateExpandedReport.mockImplementation(async () => {
      await recordCall("expand", "claude-sonnet-5", async () => ({ usage: usage(2000) }));
      throw new Error("model unavailable");
    });

    const res = await runPost();

    expect(res.status).toBe(502);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].outcome).toBe("endedEarly");
    expect(emitted[0].label).toBe("expand failed");
    expect(emitted[0].totalBilledUsd).toBeGreaterThan(0);
  });

  it("does not let a failing sink change the response", async () => {
    mocks.defaultUsageSinks.mockReturnValue([
      async () => {
        throw new Error("supabase insert exploded");
      },
    ]);

    const res = await runPost();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ expandedReport: "a full report" });
  });

  it("does not let a failing sink list change the response either", async () => {
    // Building the record runs outside emitUsageRun's totality guarantee.
    mocks.defaultUsageSinks.mockImplementation(() => {
      throw new Error("could not build the sink list");
    });

    const res = await runPost();

    expect(res.status).toBe(200);
  });

  it("keeps two concurrent expands in two separate records", async () => {
    mocks.generateExpandedReport.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await recordCall("expand", "claude-sonnet-5", async () => ({ usage: usage(2000) }));
      return "a full report";
    });

    await Promise.all([runPost(), runPost()]);

    expect(emitted).toHaveLength(2);
    expect(emitted[0].runId).not.toBe(emitted[1].runId);
    for (const record of emitted) {
      expect(record.totalCalls).toBe(1);
    }
  });
});
