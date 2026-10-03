import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCardsForTopicOnDate, getDigestForDate } from "@/lib/digests";
import { getSavedCards } from "@/lib/bookmarks";

// The column guard proves nothing is selected that the table lacks; this
// proves each full-card read actually carries subtopic, so a country filter
// gets the stored country rather than rowToCard's null fallback.

function recorder() {
  const selects: { table: string; select: string }[] = [];
  const row = { id: "d1", date: "2026-10-03", last_generated_at: null };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["eq", "order", "limit", "not", "gte", "lte", "in"]) chain[m] = () => chain;
    chain.select = (s: string) => {
      selects.push({ table, select: s });
      return chain;
    };
    chain.maybeSingle = () => Promise.resolve({ data: row, error: null });
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [row], error: null });
    return chain;
  };
  return { client: { from } as unknown as SupabaseClient, selects };
}
const hasSubtopic = (s: string) => /(^|[\s,(])subtopic([\s,)]|$)/.test(s);

describe("QA: every full-card read selects subtopic", () => {
  it("getDigestForDate (the feed)", async () => {
    const { client, selects } = recorder();
    await getDigestForDate(client, "u1", "2026-10-03").catch(() => null);
    const cards = selects.filter((s) => s.table === "cards");
    expect(cards).toHaveLength(1);
    expect(hasSubtopic(cards[0].select)).toBe(true);
  });

  it("getCardsForTopicOnDate (topic pages, Countries included)", async () => {
    const { client, selects } = recorder();
    await getCardsForTopicOnDate(client, "u1", "2026-10-03", "Countries").catch(() => null);
    const cards = selects.filter((s) => s.table === "cards");
    expect(cards).toHaveLength(1);
    expect(hasSubtopic(cards[0].select)).toBe(true);
  });

  it("getSavedCards (Saved view)", async () => {
    const { client, selects } = recorder();
    await getSavedCards(client, "u1").catch(() => null);
    const embedded = selects.find((s) => s.table === "bookmarks")?.select ?? "";
    expect(hasSubtopic(embedded)).toBe(true);
  });
});
