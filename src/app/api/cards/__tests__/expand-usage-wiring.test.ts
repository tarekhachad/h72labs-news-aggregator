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

import { recordCall } from "@/lib/usageCollector";

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

beforeEach(() => {
  vi.clearAllMocks();
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line === "string") logLines.push(line);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
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
