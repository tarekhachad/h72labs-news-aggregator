import { describe, it, expect, vi } from "vitest";
import { getSavedCards } from "@/lib/bookmarks";

// Minimal fake Supabase client mimicking the chainable
// .from().select().eq().order() shape getSavedCards uses.
function makeFakeSupabase(response: { data: unknown; error: unknown }) {
  const order = vi.fn().mockResolvedValue(response);
  const eq = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as unknown, from, select, eq, order };
}

describe("getSavedCards", () => {
  it("selects severity and front_page_rank, and passes real values through rowToCard unchanged", async () => {
    const rows = [
      {
        cards: {
          id: "card-1",
          topic: "Tech/AI",
          title: "A real headline",
          short_summary: "summary",
          labels: ["Funding", "Startups"],
          expanded_report: null,
          sources: [],
          published_at: "2026-08-01T12:00:00Z",
          created_at: "2026-08-01T12:05:00Z",
          severity: 5,
          front_page_rank: 2,
          digests: { date: "2026-08-01" },
        },
      },
    ];
    const { client, select } = makeFakeSupabase({ data: rows, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getSavedCards(client as any, "user-1");

    // A bug here (missing columns in the select string) wouldn't fail
    // TypeScript — bookmarks.ts double-casts the joined row — so asserting
    // the actual select string is what catches a regression, same as
    // digests.dedup.test.ts does for getTodaysCardSummaries.
    expect(select).toHaveBeenCalledWith(
      "cards(id, topic, short_summary, expanded_report, sources, published_at, created_at, severity, front_page_rank, title, labels, digests(date))"
    );

    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe(5);
    expect(result[0].frontPageRank).toBe(2);
    expect(result[0].title).toBe("A real headline");
    expect(result[0].labels).toEqual(["Funding", "Startups"]);
  });

  it("defaults a null severity to 1, leaves a null frontPageRank as null, and defaults missing title/labels (pre-migration row shape)", async () => {
    const rows = [
      {
        cards: {
          id: "card-1",
          topic: "Tech/AI",
          // No title/labels keys at all — a genuinely pre-5.5 row, not
          // just a row with those columns set to null, since a real
          // pre-migration row predates the columns existing.
          short_summary: "summary",
          expanded_report: null,
          sources: [],
          published_at: "2026-08-01T12:00:00Z",
          created_at: "2026-08-01T12:05:00Z",
          severity: null,
          front_page_rank: null,
          digests: { date: "2026-08-01" },
        },
      },
    ];
    const { client } = makeFakeSupabase({ data: rows, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getSavedCards(client as any, "user-1");

    expect(result[0].severity).toBe(1);
    expect(result[0].frontPageRank).toBeNull();
    expect(result[0].title).toBe("");
    expect(result[0].labels).toEqual([]);
  });
});
