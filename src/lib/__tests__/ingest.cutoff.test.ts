import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// rss-parser is the only thing ingestArticles reaches the network with, so
// mocking it turns the whole module into a pure function of (feed items,
// sinceIso, now) -- which is exactly what the cutoff logic is.
const mocks = vi.hoisted(() => ({ parseURL: vi.fn() }));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

import { ingestArticles } from "@/lib/ingest";

const NOW = "2026-08-13T12:00:00Z";
const HOURS = 60 * 60 * 1000;

/** An ISO timestamp `hours` before the frozen NOW. */
function hoursAgo(hours: number): string {
  return new Date(new Date(NOW).getTime() - hours * HOURS).toISOString();
}

/**
 * One BBC Tech/AI feed with an item per requested age, so a returned title
 * of "24h" means "the article published 24 hours ago survived the cutoff."
 */
function feedWithAges(...ages: number[]) {
  mocks.parseURL.mockResolvedValue({
    items: ages.map((h) => ({
      title: `${h}h`,
      contentSnippet: "snippet",
      link: `https://example.com/${h}`,
      isoDate: hoursAgo(h),
    })),
  });
}

async function survivingAges(sinceIso: string | null): Promise<string[]> {
  const articles = await ingestArticles(["Tech/AI"], ["BBC"], sinceIso);
  return articles.map((a) => a.title);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ingestArticles cutoff", () => {
  it("uses the 48h ceiling when there is no cursor at all (a brand-new user)", async () => {
    feedWithAges(1, 47, 49, 200);

    expect(await survivingAges(null)).toEqual(["1h", "47h"]);
  });

  it("uses the cursor when it is more recent than the ceiling", async () => {
    feedWithAges(1, 5, 20, 47);

    // Last generated 6h ago -> only the two newer items survive.
    expect(await survivingAges(hoursAgo(6))).toEqual(["1h", "5h"]);
  });

  it("clamps a stale cursor to the 48h ceiling instead of pulling a week of backlog", async () => {
    feedWithAges(1, 47, 49, 100, 160);

    // Someone returning after a week: the cursor points 168h back, but a
    // single digest must not become seven days of catch-up.
    expect(await survivingAges(hoursAgo(168))).toEqual(["1h", "47h"]);
  });

  it("treats a malformed cursor as no cursor, falling back to the ceiling", async () => {
    feedWithAges(1, 47, 49);

    // Not "everything fails the >= check" -- an unparseable timestamp must
    // not silently empty the digest.
    expect(await survivingAges("not-a-date")).toEqual(["1h", "47h"]);
  });

  it("keeps an article published exactly at the cursor", async () => {
    feedWithAges(6);

    // The filter is >=, not >: an article stamped at the same second the
    // last run finished is far likelier to be one the run never saw than a
    // duplicate of one it did.
    expect(await survivingAges(hoursAgo(6))).toEqual(["6h"]);
  });

  it("returns nothing when the cursor is newer than every article", async () => {
    feedWithAges(3, 10, 30);

    // A second run minutes after the first is allowed to produce an empty
    // digest -- that's "nothing new since you last looked," not a failure.
    expect(await survivingAges(hoursAgo(1))).toEqual([]);
  });

  it("honours a cursor a little ahead of the clock (ordinary skew) as a real cutoff", async () => {
    feedWithAges(0.5, 1, 5);

    // Within tolerance, so it wins over the ceiling and nothing older
    // survives. Falling back to the ceiling here would be the damaging
    // choice, not the safe one: a writer running a few seconds fast would
    // make EVERY later run re-ingest a full 48h.
    const skewed = new Date(new Date(NOW).getTime() + 60 * 1000).toISOString();
    expect(await survivingAges(skewed)).toEqual([]);
  });

  it("discards a cursor implausibly far ahead of the clock as corrupt, falling back to the ceiling", async () => {
    feedWithAges(1, 47, 49, 100);

    // Honouring it would NOT be self-limiting: persist_generated_cards
    // advances only today's row while getLatestGeneratedAtForUser reads the
    // max across every row, so a garbage timestamp days ahead keeps winning
    // that ordering and silently empties every digest until wall-clock time
    // overtakes it. One re-ingested window is the cheaper failure.
    const corrupt = new Date(new Date(NOW).getTime() + 72 * HOURS).toISOString();
    expect(await survivingAges(corrupt)).toEqual(["1h", "47h"]);
  });

  it("warns when it discards a corrupt future cursor, so the fallback isn't silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    feedWithAges(1);

    await survivingAges(new Date(new Date(NOW).getTime() + 72 * HOURS).toISOString());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("implausibly far ahead");
    warn.mockRestore();
  });

  it("does not warn for ordinary skew inside the tolerance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    feedWithAges(1);

    await survivingAges(new Date(new Date(NOW).getTime() + 60 * 1000).toISOString());

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats an empty-string cursor the same as no cursor, falling back to the ceiling", async () => {
    feedWithAges(1, 47, 49);

    // "" is falsy, so the `sinceIso ? new Date(sinceIso) : null` guard
    // takes the null branch rather than constructing `new Date("")`
    // (Invalid Date) and relying on the NaN check below it.
    expect(await survivingAges("")).toEqual(["1h", "47h"]);
  });
});
