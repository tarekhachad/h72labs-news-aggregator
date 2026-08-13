import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// F.4.4's newest change (the one this file targets): a since-cursor ahead of
// this machine's clock is split into two cases by FUTURE_CURSOR_TOLERANCE_MS
// (5 minutes, see src/lib/ingest.ts) -- within tolerance it's honoured as an
// ordinary cutoff, beyond it it's discarded as corrupt in favour of the 48h
// ceiling. The existing ingest.cutoff.test.ts exercises both sides with
// margin (60s inside, 72h outside) but never pins down the boundary itself --
// this file drives it to the exact millisecond on both sides, plus confirms
// the console.warn on the corrupt path can't itself break the run.

const mocks = vi.hoisted(() => ({ parseURL: vi.fn() }));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

import { ingestArticles } from "@/lib/ingest";

const NOW = "2026-08-13T12:00:00.000Z";
const TOLERANCE_MS = 5 * 60 * 1000;

function feedWithAges(...ages: number[]) {
  mocks.parseURL.mockResolvedValue({
    items: ages.map((h) => ({
      title: `${h}h`,
      contentSnippet: "snippet",
      link: `https://example.com/${h}`,
      isoDate: new Date(new Date(NOW).getTime() - h * 60 * 60 * 1000).toISOString(),
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

describe("ingestArticles cutoff — exact tolerance boundary", () => {
  it("honours a cursor exactly AT the tolerance (now + 5min, to the ms) as a real cutoff, not corrupt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    feedWithAges(0.5, 1, 5);
    const atBoundary = new Date(new Date(NOW).getTime() + TOLERANCE_MS).toISOString();

    // Honoured means cutoff === atBoundary, which is in the future relative
    // to every real article -- so nothing survives, same as the "ordinary
    // skew" case one minute inside tolerance.
    expect(await survivingAges(atBoundary)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats one millisecond PAST the tolerance as corrupt, falling back to the 48h ceiling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    feedWithAges(1, 47, 49);
    const pastBoundary = new Date(new Date(NOW).getTime() + TOLERANCE_MS + 1).toISOString();

    // Discarded as corrupt -> falls back to the ceiling -> the 47h article
    // (which a genuinely-honoured future cutoff would also have excluded,
    // same as the at-boundary case) now survives, proving the ceiling — not
    // the corrupt cursor — is the active cutoff.
    expect(await survivingAges(pastBoundary)).toEqual(["1h", "47h"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("honours a cursor one millisecond BEFORE the tolerance boundary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    feedWithAges(0.5, 1, 5);
    const justInside = new Date(new Date(NOW).getTime() + TOLERANCE_MS - 1).toISOString();

    expect(await survivingAges(justInside)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a console.warn that itself throws does not propagate out of ingestArticles or block the fallback from taking effect", async () => {
    // Simulates an environment where console.warn has been overridden by
    // something that can throw (e.g. a logging shim) -- the corrupt-cursor
    // path must not depend on that call succeeding to keep going.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger exploded");
    });
    feedWithAges(1, 47, 49);
    const corrupt = new Date(new Date(NOW).getTime() + 72 * 60 * 60 * 1000).toISOString();

    let threw = false;
    let result: string[] = [];
    try {
      result = await survivingAges(corrupt);
    } catch {
      threw = true;
    }

    warn.mockRestore();
    // Document actual behavior precisely rather than assuming: if this ever
    // flips to `threw === true`, ingestArticles is NOT resilient to a
    // throwing console.warn and the whole digest run would fail on what's
    // supposed to be a best-effort diagnostic log.
    expect(threw).toBe(false);
    expect(result).toEqual(["1h", "47h"]);
  });
});
