import { describe, it, expect, vi } from "vitest";
import { getTodaysCardSummaries } from "@/lib/digests";

// Minimal fake Supabase client that mimics the chainable
// .from().select().eq() shape getTodaysCardSummaries uses, and records how
// it was called so we can assert the query shape.
function makeFakeSupabase(response: { data: unknown; error: unknown }) {
  const eq = vi.fn().mockResolvedValue(response);
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as unknown, from, select, eq };
}

describe("getTodaysCardSummaries", () => {
  it("queries the cards table, selecting topic + short_summary, scoped to one digest_id", async () => {
    const rows = [
      { topic: "Tech/AI", short_summary: "AI story" },
      { topic: "US Finance", short_summary: "Finance story" },
    ];
    const { client, from, select, eq } = makeFakeSupabase({ data: rows, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getTodaysCardSummaries(client as any, "digest-123");

    expect(from).toHaveBeenCalledWith("cards");
    expect(select).toHaveBeenCalledWith("topic, short_summary");
    expect(eq).toHaveBeenCalledWith("digest_id", "digest-123");

    expect(result).toEqual([
      { topic: "Tech/AI", shortSummary: "AI story" },
      { topic: "US Finance", shortSummary: "Finance story" },
    ]);
  });

  it("returns an empty array when there are no cards yet", async () => {
    const { client } = makeFakeSupabase({ data: null, error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getTodaysCardSummaries(client as any, "digest-123");
    expect(result).toEqual([]);
  });

  it("throws a descriptive error when the query fails", async () => {
    const { client } = makeFakeSupabase({ data: null, error: { message: "boom" } });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getTodaysCardSummaries(client as any, "digest-123")
    ).rejects.toThrow(/getTodaysCardSummaries: boom/);
  });
});
