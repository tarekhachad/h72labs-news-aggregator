import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DAILY_CARDS_PER_TOPIC_CEILING,
  FIRST_RUN_CARDS_PER_TOPIC,
  TOP_UP_CARDS_PER_TOPIC,
  applyCardCap,
  perRunAllowanceFor,
  topicAllowance,
  type TriagedCluster,
} from "@/lib/cardCap";
import type { RunShape } from "@/lib/usageRecord";
import type { Cluster, Topic } from "@/types";

// The tier and the ceiling: how many cards a run may add to a topic, and the
// bound across every run of one digest. cardCap.test.ts covers selection on
// the day's first run; this file covers everything that varies by run.

const RUN_SHAPES: RunShape[] = ["firstEver", "firstOfDay", "sameDayTopUp", "unknown"];

function item(topic: Topic, severity: number, articleCount = 1, title = "t"): TriagedCluster {
  const cluster: Cluster = {
    topic,
    articles: Array.from({ length: articleCount }, (_, a) => ({
      title: `${title}-${a}`,
      snippet: "snippet",
      url: `https://example.com/${title}-${a}`,
      source: "BBC",
      topic,
      publishedAt: "2026-07-31T12:00:00Z",
    })),
  };
  return { cluster, severity };
}

/** `n` clusters for one topic, severities descending from `topSeverity`, floored at 1. */
function group(topic: Topic, n: number, topSeverity = 5): TriagedCluster[] {
  return Array.from({ length: n }, (_, i) =>
    item(topic, Math.max(1, topSeverity - i), 1, `${topic}-${i}`)
  );
}

/** `n` cards already persisted for a topic — only `topic` is read. */
function existing(topic: Topic, n: number): { topic: Topic }[] {
  return Array.from({ length: n }, () => ({ topic }));
}

describe("perRunAllowanceFor", () => {
  it("gives a first run the full allowance", () => {
    expect(perRunAllowanceFor("firstEver")).toBe(FIRST_RUN_CARDS_PER_TOPIC);
    expect(perRunAllowanceFor("firstOfDay")).toBe(FIRST_RUN_CARDS_PER_TOPIC);
  });

  it("gives a top-up the smaller allowance", () => {
    expect(perRunAllowanceFor("sameDayTopUp")).toBe(TOP_UP_CARDS_PER_TOPIC);
  });

  // The failed-lookup case. Fail closed: the run might be a top-up against a
  // topic already at the ceiling, and granting the first-run allowance there
  // writes Sonnet cards no clamp can take back.
  it("treats an unknown run shape as a top-up rather than a first run", () => {
    expect(perRunAllowanceFor("unknown")).toBe(TOP_UP_CARDS_PER_TOPIC);
  });

  // Guards the exhaustive switch: a run shape added without a case is a type
  // error, but a run shape added *with* a `default` would silently return
  // whatever that default is, and this is what catches that.
  it("returns a positive allowance for every run shape", () => {
    for (const shape of RUN_SHAPES) {
      expect(perRunAllowanceFor(shape)).toBeGreaterThan(0);
    }
  });
});

describe("topicAllowance", () => {
  it("uses the per-run allowance when the ceiling leaves more headroom", () => {
    expect(topicAllowance(FIRST_RUN_CARDS_PER_TOPIC, 2)).toBe(FIRST_RUN_CARDS_PER_TOPIC);
  });

  it("narrows to the ceiling's headroom when that is smaller", () => {
    // 14 − 10 = 4, below the first run's 8.
    expect(topicAllowance(FIRST_RUN_CARDS_PER_TOPIC, 10)).toBe(4);
    expect(topicAllowance(FIRST_RUN_CARDS_PER_TOPIC, 13)).toBe(1);
  });

  it("clamps to zero at the ceiling and never goes negative", () => {
    expect(topicAllowance(TOP_UP_CARDS_PER_TOPIC, DAILY_CARDS_PER_TOPIC_CEILING)).toBe(0);
    // A topic already past the ceiling — possible on a digest that predates
    // this cap — must yield 0, not a negative slice length.
    expect(topicAllowance(TOP_UP_CARDS_PER_TOPIC, 20)).toBe(0);
  });

  it("leaves the per-run allowance unclamped when the existing count is unknown", () => {
    expect(topicAllowance(TOP_UP_CARDS_PER_TOPIC, null)).toBe(TOP_UP_CARDS_PER_TOPIC);
    expect(topicAllowance(FIRST_RUN_CARDS_PER_TOPIC, null)).toBe(FIRST_RUN_CARDS_PER_TOPIC);
  });

  // The two assertions above cannot actually distinguish "skip the ceiling"
  // from "apply the ceiling against zero", because the ceiling exceeds every
  // allowance this app passes: min(8, 14 - 0) is 8 either way. An allowance
  // above the ceiling is what separates them, and it is the only thing that
  // holds the null branch to its stated meaning.
  it("skips the ceiling on an unknown count rather than applying it against zero", () => {
    const aboveCeiling = DAILY_CARDS_PER_TOPIC_CEILING + 6;

    expect(topicAllowance(aboveCeiling, null)).toBe(aboveCeiling);
    expect(topicAllowance(aboveCeiling, 0)).toBe(DAILY_CARDS_PER_TOPIC_CEILING);
  });

  // While this holds, the route's choice of null over [] on a failed lookup
  // is correct but unobservable end to end: every allowance it passes is
  // below the ceiling, so both produce the same number. If the ceiling ever
  // drops to or below the first-run allowance that stops being true, the
  // route's branch becomes load-bearing, and it needs a wiring test of its
  // own rather than only this unit-level one.
  it("keeps the ceiling above every per-run allowance", () => {
    expect(DAILY_CARDS_PER_TOPIC_CEILING).toBeGreaterThan(FIRST_RUN_CARDS_PER_TOPIC);
    expect(DAILY_CARDS_PER_TOPIC_CEILING).toBeGreaterThan(TOP_UP_CARDS_PER_TOPIC);
  });
});

describe("applyCardCap — the top-up allowance", () => {
  // The decided semantics: a top-up allows 2 per topic by run, not by whether
  // that particular topic already has cards. A topic that was quiet this
  // morning gets 2 this evening, the same as one that already has 8.
  it("allows two per topic on a top-up, including a topic with no cards yet", () => {
    const input = [...group("Tech/AI", 12), ...group("Morocco", 12)];
    const { kept } = applyCardCap(input, {
      runShape: "sameDayTopUp",
      existingCards: existing("Tech/AI", 8),
    });

    expect(kept.filter((k) => k.cluster.topic === "Tech/AI")).toHaveLength(2);
    expect(kept.filter((k) => k.cluster.topic === "Morocco")).toHaveLength(2);
  });

  it("keeps the two highest-severity and reports the allowance it applied", () => {
    const input = group("Tech/AI", 12, 5);
    const { kept, cuts } = applyCardCap(input, {
      runShape: "sameDayTopUp",
      existingCards: [],
    });

    expect(kept.map((k) => k.severity)).toEqual([5, 4]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ topic: "Tech/AI", allowance: 2, total: 12, dropped: 10 });
    expect(cuts[0].severities).toHaveLength(10);
  });
});

describe("applyCardCap — the per-digest ceiling", () => {
  it("narrows a run to the ceiling's remaining headroom", () => {
    const input = group("Tech/AI", 12);
    const nearCeiling = existing("Tech/AI", 13);

    // Binds on a top-up (min(2, 1)) and on a first run (min(8, 1)) alike.
    expect(applyCardCap(input, { runShape: "sameDayTopUp", existingCards: nearCeiling }).kept)
      .toHaveLength(1);
    expect(applyCardCap(input, { runShape: "firstOfDay", existingCards: nearCeiling }).kept)
      .toHaveLength(1);
  });

  it("allows nothing for a topic at or past the ceiling, and leaves its siblings alone", () => {
    const input = [...group("Tech/AI", 5), ...group("Morocco", 5)];

    for (const already of [DAILY_CARDS_PER_TOPIC_CEILING, DAILY_CARDS_PER_TOPIC_CEILING + 1]) {
      const { kept, cuts } = applyCardCap(input, {
        runShape: "sameDayTopUp",
        existingCards: existing("Tech/AI", already),
      });

      expect(kept.filter((k) => k.cluster.topic === "Tech/AI")).toHaveLength(0);
      // Counts are per topic, never global: Morocco still gets its two.
      expect(kept.filter((k) => k.cluster.topic === "Morocco")).toHaveLength(2);

      const cut = cuts.find((c) => c.topic === "Tech/AI");
      expect(cut).toMatchObject({ allowance: 0, dropped: 5, total: 5 });
    }
  });

  it("does not apply the ceiling when the existing count is unknown", () => {
    const { kept } = applyCardCap(group("Tech/AI", 12), {
      runShape: "sameDayTopUp",
      existingCards: null,
    });

    expect(kept).toHaveLength(TOP_UP_CARDS_PER_TOPIC);
  });

  it("ignores existing cards for a topic this run produced nothing in", () => {
    const { kept, cuts } = applyCardCap(group("Tech/AI", 2), {
      runShape: "firstOfDay",
      existingCards: existing("Geopolitics", 14),
    });

    expect(kept).toHaveLength(2);
    expect(cuts).toEqual([]);
  });

  // The ceiling cannot bind at the shipped run count, so this is the
  // arithmetic that makes it so — and the reason the ceiling is still worth
  // having is that this test cannot see a dial changed in production.
  it("cannot be reached by the per-run allowances at the seeded run count", () => {
    const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");
    // Matched positionally within the VALUES tuple, anchored on the column
    // list that precedes it. A renamed column makes this null and fails the
    // next assertion; a transposed tuple would capture the wrong number,
    // which the arithmetic below still catches for every value above 4.
    const seeded = schema.match(
      /max_digest_runs_per_window, max_expands_per_window,[\s\S]*?values \(1, true, [\d.]+, [\d.]+, (\d+),/
    );
    expect(seeded).not.toBeNull();

    const runs = Number(seeded?.[1]);
    expect(runs).toBeGreaterThan(0);
    expect(
      FIRST_RUN_CARDS_PER_TOPIC + TOP_UP_CARDS_PER_TOPIC * (runs - 1)
    ).toBeLessThanOrEqual(DAILY_CARDS_PER_TOPIC_CEILING);
  });
});

describe("applyCardCap — corroboration as the severity tie-break", () => {
  it("prefers the better-corroborated cluster at the allowance boundary", () => {
    // Both severity 3; the second is carried by four sources.
    const thin = item("Tech/AI", 3, 1, "thin");
    const corroborated = item("Tech/AI", 3, 4, "corroborated");
    const { kept } = applyCardCap([thin, corroborated], {
      runShape: "sameDayTopUp",
      existingCards: existing("Tech/AI", 13), // allowance 1
    });

    expect(kept).toEqual([corroborated]);
  });

  it("still lets severity dominate corroboration", () => {
    const loneBigStory = item("Tech/AI", 4, 1, "lone");
    const wellCoveredSmallStory = item("Tech/AI", 3, 5, "covered");
    const { kept } = applyCardCap([wellCoveredSmallStory, loneBigStory], {
      runShape: "sameDayTopUp",
      existingCards: existing("Tech/AI", 13),
    });

    expect(kept).toEqual([loneBigStory]);
  });

  it("returns a subsequence of the input under the corroboration tie-break too", () => {
    // Severity-equal, corroboration descending in reverse input order, so the
    // selected set is not a prefix — the output must still be in input order.
    const input = [
      item("Tech/AI", 3, 1, "a"),
      item("Tech/AI", 3, 4, "b"),
      item("Tech/AI", 3, 3, "c"),
      item("Tech/AI", 3, 2, "d"),
    ];
    const { kept } = applyCardCap(input, {
      runShape: "sameDayTopUp",
      existingCards: [],
    });

    expect(kept).toEqual([input[1], input[2]]);
  });
});
