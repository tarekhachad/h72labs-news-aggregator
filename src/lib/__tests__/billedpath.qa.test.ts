import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster } from "@/types";

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  FakeAnthropic.APIError = class APIError extends Error {};
  return { default: FakeAnthropic };
});

const cluster = (n: number): Cluster => ({
  topic: "Tech/AI",
  articles: Array.from({ length: n }, (_, i) => ({
    title: `t${i}`, snippet: "s", url: `https://e.com/${i}`, source: "BBC",
    topic: "Tech/AI", publishedAt: "2026-07-31T12:00:00Z",
  })) as Cluster["articles"],
});

beforeEach(() => {
  mockParse.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const throwing = () => { throw new Error("console dead"); };
const killConsole = () => {
  for (const l of ["log", "warn", "error"] as const) vi.spyOn(console, l).mockImplementation(throwing);
};

describe("bestEffortLog all levels", () => {
  for (const level of ["log", "warn", "error"] as const) {
    it(`console.${level}: forwards args when healthy, swallows when throwing`, async () => {
      const { bestEffortLog } = await import("@/lib/bestEffortLog");
      const spy = vi.spyOn(console, level).mockImplementation(() => {});
      bestEffortLog(level, "a", 1);
      expect(spy).toHaveBeenCalledWith("a", 1);
      spy.mockImplementation(throwing);
      expect(() => bestEffortLog(level, "a")).not.toThrow();
    });
  }
});

describe("rankFrontPage with every console dead", () => {
  it("resolves null on a parse failure", async () => {
    killConsole();
    mockParse.mockRejectedValue(new Error("boom"));
    const { rankFrontPage } = await import("@/lib/rank");
    await expect(rankFrontPage([{ topic: "Tech/AI", severity: 3, text: "x" }])).resolves.toBeNull();
  });
  it("resolves null on missing parsed_output (billed, unparseable)", async () => {
    killConsole();
    mockParse.mockResolvedValue({ parsed_output: null, stop_reason: "max_tokens" });
    const { rankFrontPage } = await import("@/lib/rank");
    await expect(rankFrontPage([{ topic: "Tech/AI", severity: 3, text: "x" }])).resolves.toBeNull();
  });
});

describe("writeCard", () => {
  it("retry is still made and card returned when every console throws", async () => {
    killConsole();
    mockParse
      .mockResolvedValueOnce({ parsed_output: { title: "T", shortSummary: "cut off mid", labels: [] }, stop_reason: "end_turn" })
      .mockResolvedValueOnce({ parsed_output: { title: "T", shortSummary: "Finished.", labels: [] }, stop_reason: "end_turn" });
    const { writeCard } = await import("@/lib/writeCard");
    const card = await writeCard(cluster(1), 3);
    expect(card.shortSummary).toBe("Finished.");
    expect(mockParse).toHaveBeenCalledTimes(2);
  });
  it("normal path (1 and 3 articles) makes one call each and takes freshest publishedAt", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockParse.mockResolvedValue({ parsed_output: { title: "T", shortSummary: "Done.", labels: [] }, stop_reason: "end_turn" });
    const { writeCard } = await import("@/lib/writeCard");
    await writeCard(cluster(1), 3);
    const c3 = cluster(3);
    c3.articles[1].publishedAt = "2026-08-01T00:00:00Z";
    const card = await writeCard(c3, 3);
    expect(mockParse).toHaveBeenCalledTimes(2);
    expect(card.publishedAt).toBe("2026-08-01T00:00:00Z");
  });
  it("empty cluster rejects without touching console or the SDK", async () => {
    const spies = (["log", "warn", "error"] as const).map((l) => vi.spyOn(console, l).mockImplementation(() => {}));
    const { writeCard, EmptyClusterError } = await import("@/lib/writeCard");
    await expect(writeCard({ topic: "Tech/AI", articles: [] }, 1)).rejects.toBeInstanceOf(EmptyClusterError);
    expect(mockParse).not.toHaveBeenCalled();
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });
});

describe("isSameStory with every console dead", () => {
  it("fails open when parsed_output is null and when parse rejects", async () => {
    killConsole();
    const { isSameStory } = await import("@/lib/dedup");
    mockParse.mockResolvedValueOnce({ parsed_output: null });
    await expect(isSameStory("a", "b")).resolves.toBe(false);
    mockParse.mockRejectedValueOnce(new Error("x"));
    await expect(isSameStory("a", "b")).resolves.toBe(false);
  });
});
