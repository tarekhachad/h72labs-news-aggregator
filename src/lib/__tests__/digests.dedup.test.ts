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
  it("queries the cards table, selecting id + topic + short_summary + severity, scoped to one digest_id", async () => {
    const rows = [
      { id: "card-1", topic: "Tech/AI", short_summary: "AI story", severity: 4 },
      { id: "card-2", topic: "US Finance", short_summary: "Finance story", severity: null },
    ];
    const { client, from, select, eq } = makeFakeSupabase({ data: rows, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getTodaysCardSummaries(client as any, "digest-123");

    expect(from).toHaveBeenCalledWith("cards");
    expect(select).toHaveBeenCalledWith("id, topic, short_summary, severity");
    expect(eq).toHaveBeenCalledWith("digest_id", "digest-123");

    expect(result).toEqual([
      { id: "card-1", topic: "Tech/AI", shortSummary: "AI story", severity: 4 },
      // Null severity (a row persisted before the column existed) defaults
      // to the lowest tier, same fallback rowToCard uses.
      { id: "card-2", topic: "US Finance", shortSummary: "Finance story", severity: 1 },
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
