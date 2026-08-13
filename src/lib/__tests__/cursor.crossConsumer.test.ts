import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The two consumers of src/lib/cursor.ts's shared threshold -- the query in
// getLatestGeneratedAtForUser (digests.ts) that refuses to SELECT a corrupt
// cursor, and the cutoff logic in ingestArticles (ingest.ts) that refuses to
// USE one -- are each unit-tested against the threshold in isolation
// (digests.latestGeneratedAt*.test.ts, ingest.cutoff*.test.ts) and wired
// together only via a fully-mocked route.ts in cursor-corruption-wiring.test.ts
// (which mocks getLatestGeneratedAtForUser's return value directly, never
// running its real query logic).
//
// This file is the one place both REAL implementations run back to back with
// nothing mocked between them (only rss-parser, at the network boundary, and
// Supabase, via a filtering fake) -- so a drift between the two thresholds
// that both other layers would miss (the query silently handing back a value
// the consumer then discards) would surface here as a real behavioral
// mismatch, not just a mismatched mock expectation.

const mocks = vi.hoisted(() => ({ parseURL: vi.fn() }));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

import { getLatestGeneratedAtForUser } from "@/lib/digests";
import { ingestArticles } from "@/lib/ingest";
import { FUTURE_CURSOR_TOLERANCE_MS } from "@/lib/cursor";

interface DigestRow {
  user_id: string;
  last_generated_at: string | null;
}

function makeRealisticSupabase(rows: DigestRow[]) {
  function builder(current: DigestRow[]) {
    return {
      eq(col: keyof DigestRow, val: unknown) {
        return builder(current.filter((r) => r[col] === val));
      },
      not(col: keyof DigestRow, op: string, val: unknown) {
        if (op !== "is" || val !== null) {
          throw new Error(`fake supabase: unsupported not() usage: ${op} ${val}`);
        }
        return builder(current.filter((r) => r[col] !== null));
      },
      lte(col: keyof DigestRow, val: string) {
        return builder(
          current.filter((r) => r[col] !== null && (r[col] as string) <= val)
        );
      },
      order(col: keyof DigestRow, opts: { ascending: boolean }) {
        const sorted = [...current].sort((a, b) => {
          const av = a[col] as string;
          const bv = b[col] as string;
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return opts.ascending ? cmp : -cmp;
        });
        return builder(sorted);
      },
      limit(n: number) {
        return builder(current.slice(0, n));
      },
      async maybeSingle() {
        return { data: current[0] ?? null, error: null };
      },
    };
  }

  return {
    from: vi.fn((table: string) => {
      if (table !== "digests") throw new Error(`fake supabase: unexpected table ${table}`);
      return { select: vi.fn((_cols: string) => builder(rows)) };
    }),
  } as unknown;
}

const NOW = "2026-08-13T12:00:00.000Z";
const HOURS = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(new Date(NOW).getTime() - hours * HOURS).toISOString();
}

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getLatestGeneratedAtForUser + ingestArticles: real cross-consumer agreement", () => {
  it("a cursor sitting exactly at the query's plausibility limit is selected by the query AND honoured (not discarded as corrupt) by ingest", async () => {
    const atLimit = new Date(new Date(NOW).getTime() + FUTURE_CURSOR_TOLERANCE_MS).toISOString();
    const client = makeRealisticSupabase([
      { user_id: "user-1", last_generated_at: atLimit },
      { user_id: "user-1", last_generated_at: hoursAgo(20) },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cursor = await getLatestGeneratedAtForUser(client as never, "user-1");
    expect(cursor).toBe(atLimit);

    feedWithAges(0.5, 1, 5);
    const articles = await ingestArticles(["Tech/AI"], ["BBC"], cursor);

    // Honoured as a real (if future-skewed) cutoff -> every real article is
    // older than it -> none survive. If ingest.ts's tolerance were even 1ms
    // stricter than the query's, this same value would instead be discarded
    // as corrupt and fall back to the 48h ceiling, and the 5h/1h/0.5h items
    // would wrongly survive.
    expect(articles).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a corrupted far-future row never reaches ingest at all -- the query already fell through to the real cursor, so ingest sees a plain plausible value and never fires its own fallback path", async () => {
    const corrupt = new Date(new Date(NOW).getTime() + 72 * HOURS).toISOString();
    const legit = hoursAgo(6);
    const client = makeRealisticSupabase([
      { user_id: "user-1", last_generated_at: corrupt },
      { user_id: "user-1", last_generated_at: legit },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cursor = await getLatestGeneratedAtForUser(client as never, "user-1");
    expect(cursor).toBe(legit);

    feedWithAges(1, 5, 20, 47);
    const articles = await ingestArticles(["Tech/AI"], ["BBC"], cursor);

    // Cursor is 6h ago -> only items newer than that survive.
    expect(articles.map((a) => a.title)).toEqual(["1h", "5h"]);
    // And ingest's own corruption guard never had to fire, because the
    // corrupt value never reached it in the first place.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a user with no rows at all (never generated) gets null from the query, which ingest treats as the plain 48h ceiling", async () => {
    const client = makeRealisticSupabase([]);
    feedWithAges(1, 47, 49, 100);

    const cursor = await getLatestGeneratedAtForUser(client as never, "user-1");
    expect(cursor).toBeNull();

    const articles = await ingestArticles(["Tech/AI"], ["BBC"], cursor);
    expect(articles.map((a) => a.title)).toEqual(["1h", "47h"]);
  });
});
