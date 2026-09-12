import { describe, it, expect } from "vitest";
import { formatUsd, SMALLEST_SHOWN_USD } from "@/lib/usage";
import {
  buildCostReport,
  headlineFigures,
  parseUsageRunLines,
  renderCostHtml,
  renderCostMarkdown,
  sectionTitle,
  type CostReport,
} from "@/lib/costReport";
import type { PublicUsageRunRecord } from "@/lib/usageRecord";

function run(overrides: Partial<PublicUsageRunRecord> = {}): PublicUsageRunRecord {
  return {
    schemaVersion: 1,
    runId: "run-1",
    route: "digest",
    digestId: "digest-1",
    cardId: null,
    outcome: "complete",
    label: "digest complete",
    runShape: "cold",
    pricedAtIso: "2026-09-11T12:00:00.000Z",
    topicCount: 2,
    sourceCount: 3,
    articleCount: 40,
    clusterCount: 12,
    clustersAfterDedup: 12,
    notableCount: 8,
    cardsDroppedByCap: 0,
    cardsWritten: 8,
    cardsFailed: 0,
    rankApplied: true,
    totalCalls: 107,
    totalCallsWithoutUsage: 0,
    totalTokens: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    totalBilledUsd: 0.335,
    totalListUsd: 0.335,
    isFloor: false,
    unpricedModels: [],
    clockUsable: true,
    pricingVerifiedOn: "2026-09-11",
    stages: [],
    ...overrides,
  };
}

describe("parseUsageRunLines", () => {
  it("reads well-formed lines and ignores blank ones", () => {
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify(run()),
      "",
      "   ",
      JSON.stringify(run({ runId: "run-2" })),
    ]);

    expect(records).toHaveLength(2);
    expect(skipped).toBe(0);
  });

  it("skips a truncated final line instead of throwing", () => {
    // The normal result of a process killed mid-write. A report that died on
    // it would be useless exactly when something had gone wrong.
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify(run()),
      '{"schemaVersion":1,"route":"dig',
    ]);

    expect(records).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("counts what it skipped rather than shrinking the sample silently", () => {
    const { records, skipped } = parseUsageRunLines(["not json", "[]", "null", "42"]);

    expect(records).toEqual([]);
    expect(skipped).toBe(4);
  });

  it("refuses a record from a future schema version", () => {
    // Version 2 may mean something different by the same field names.
    // Averaging it in with version 1 is the failure this field exists to stop.
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify({ ...run(), schemaVersion: 2 }),
    ]);

    expect(records).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("refuses a record missing the fields every figure depends on", () => {
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify({ ...run(), totalBilledUsd: undefined }),
      JSON.stringify({ ...run(), isFloor: undefined }),
      JSON.stringify({ ...run(), route: "something-else" }),
    ]);

    expect(records).toEqual([]);
    expect(skipped).toBe(3);
  });
});

describe("buildCostReport: segmentation", () => {
  it("never exposes an all-runs mean anywhere on the report", () => {
    // Structural, not stylistic. A cold run and a warm run cost materially
    // different amounts, so a blended mean describes no real user while
    // looking authoritative. The field does not exist, so no renderer can
    // print one by accident.
    const report = buildCostReport([run(), run({ runShape: "warmSameDay" })]);

    for (const key of Object.keys(report)) {
      expect(key).not.toMatch(/mean/i);
    }
  });

  it("keeps cold and warm runs in separate sections", () => {
    const report = buildCostReport([
      run({ totalBilledUsd: 0.4 }),
      run({ totalBilledUsd: 0.4 }),
      run({ runShape: "warmSameDay", totalBilledUsd: 0.1 }),
      run({ runShape: "warmSameDay", totalBilledUsd: 0.1 }),
    ]);

    expect(report.sections).toHaveLength(2);
    const cold = report.sections.find((s) => s.runShape === "cold");
    const warm = report.sections.find((s) => s.runShape === "warmSameDay");
    expect(cold!.billedUsd.mean).toBeCloseTo(0.4, 10);
    expect(warm!.billedUsd.mean).toBeCloseTo(0.1, 10);
  });

  it("keeps an expand apart from a digest even though both are runShape unknown", () => {
    // An expand is "unknown" because it has no cold/warm dimension at all; a
    // digest is "unknown" because its existing-cards fetch failed. Pooling
    // them would average one Sonnet call with a whole pipeline.
    const report = buildCostReport([
      run({ route: "expand", runShape: "unknown", totalBilledUsd: 0.012 }),
      run({ runShape: "unknown", totalBilledUsd: 0.335 }),
    ]);

    expect(report.sections).toHaveLength(2);
    const expand = report.sections.find((s) => s.route === "expand");
    const digest = report.sections.find((s) => s.route === "digest");
    expect(expand!.billedUsd.mean).toBeCloseTo(0.012, 10);
    expect(digest!.billedUsd.mean).toBeCloseTo(0.335, 10);
  });

  it("orders sections stably so an unchanged log regenerates byte-identically", () => {
    // (C) COST.md is committed so `git diff` is the trend history. Reordering
    // noise would make every regeneration look like a change.
    const records = [
      run({ route: "expand", runShape: "unknown" }),
      run({ runShape: "warmSameDay" }),
      run({ runShape: "cold" }),
    ];
    const forward = buildCostReport(records);
    const reversed = buildCostReport([...records].reverse());

    expect(forward.sections.map(sectionTitle)).toEqual(reversed.sections.map(sectionTitle));
    expect(renderCostMarkdown(forward)).toBe(renderCostMarkdown(reversed));
  });
});

describe("buildCostReport: floor runs are counted, never averaged", () => {
  it("excludes a floor run from the mean", () => {
    const report = buildCostReport([
      run({ totalBilledUsd: 0.4 }),
      run({ totalBilledUsd: 0.4 }),
      // A floor run's total is a LOWER BOUND -- the real spend is higher by
      // an unknown amount. Averaging it in drags the line down invisibly.
      run({ totalBilledUsd: 0.01, isFloor: true }),
    ]);

    const section = report.sections[0];
    expect(section.totalRuns).toBe(3);
    expect(section.floorRuns).toBe(1);
    expect(section.usableRuns).toBe(2);
    expect(section.billedUsd.mean).toBeCloseTo(0.4, 10);
    expect(section.billedUsd.n).toBe(2);
  });

  it("puts the exclusion count on the report's face", () => {
    const report = buildCostReport([run(), run({ isFloor: true })]);
    expect(report.floorRuns).toBe(1);
  });

  it("reports no mean at all when every run in a shape is a floor", () => {
    // Null, not 0. A zero here would read as "these runs were free".
    const report = buildCostReport([run({ isFloor: true }), run({ isFloor: true })]);

    const section = report.sections[0];
    expect(section.usableRuns).toBe(0);
    expect(section.billedUsd.mean).toBeNull();
    expect(section.isTrend).toBe(false);
  });
});

describe("buildCostReport: nulls are excluded samples, not zeros", () => {
  it("does not count a null field as a zero measurement", () => {
    // The run that ended early never learned cardsWritten. Treating that as 0
    // would pull the mean toward nothing with no trace that it had.
    const report = buildCostReport([
      run({ cardsWritten: 8 }),
      run({ cardsWritten: null, outcome: "endedEarly" }),
    ]);

    const section = report.sections[0];
    expect(section.cardsWritten.mean).toBe(8);
    expect(section.cardsWritten.n).toBe(1);
    expect(section.billedUsd.n).toBe(2);
  });

  it("carries a different denominator per field within the same runs", () => {
    // Exactly why `n` sits next to every mean.
    const report = buildCostReport([
      run({ cardsWritten: 4, articleCount: null }),
      run({ cardsWritten: null, articleCount: 40 }),
    ]);

    const section = report.sections[0];
    expect(section.cardsWritten.n).toBe(1);
    expect(section.articleCount.n).toBe(1);
    expect(section.calls.n).toBe(2);
  });

  it("keeps a measured zero as a real sample", () => {
    const report = buildCostReport([run({ cardsWritten: 0 }), run({ cardsWritten: 4 })]);

    const section = report.sections[0];
    expect(section.cardsWritten.mean).toBe(2);
    expect(section.cardsWritten.n).toBe(2);
  });
});

describe("buildCostReport: a single run is not a trend", () => {
  it("marks a one-run section as not a trend", () => {
    const report = buildCostReport([run()]);
    expect(report.sections[0].isTrend).toBe(false);
  });

  it("marks a two-run section as a trend", () => {
    const report = buildCostReport([run(), run({ runId: "run-2" })]);
    expect(report.sections[0].isTrend).toBe(true);
  });

  it("counts only USABLE runs toward that threshold", () => {
    // Two runs, but one is a floor -- so exactly one real sample.
    const report = buildCostReport([run(), run({ isFloor: true })]);
    expect(report.sections[0].isTrend).toBe(false);
  });
});

describe("buildCostReport: provenance", () => {
  it("reports the date range from the priced instants", () => {
    const report = buildCostReport([
      run({ pricedAtIso: "2026-09-09T08:00:00.000Z" }),
      run({ pricedAtIso: "2026-09-11T20:00:00.000Z" }),
    ]);

    expect(report.firstRunDate).toBe("2026-09-09");
    expect(report.lastRunDate).toBe("2026-09-11");
  });

  it("ignores undated runs rather than inventing a date for them", () => {
    const report = buildCostReport([
      run({ pricedAtIso: null, clockUsable: false }),
      run({ pricedAtIso: "2026-09-11T20:00:00.000Z" }),
    ]);

    expect(report.firstRunDate).toBe("2026-09-11");
    expect(report.lastRunDate).toBe("2026-09-11");
  });

  it("has no dates at all when nothing is dated", () => {
    const report = buildCostReport([run({ pricedAtIso: null, clockUsable: false })]);
    expect(report.firstRunDate).toBeNull();
    expect(report.lastRunDate).toBeNull();
  });

  it("surfaces runs that span more than one rate card", () => {
    // The 2026-09-11 correction took eleven days to notice. Figures from
    // either side of one are not comparable without repricing.
    const report = buildCostReport([
      run({ pricingVerifiedOn: "2026-08-15" }),
      run({ pricingVerifiedOn: "2026-09-11" }),
    ]);

    expect(report.pricingVerifiedOn).toEqual(["2026-08-15", "2026-09-11"]);
  });

  it("carries the parser's skipped count onto the report", () => {
    const report = buildCostReport([run()], 7);
    expect(report.skippedLines).toBe(7);
  });
});

describe("the two renderers cannot drift apart", () => {
  const report: CostReport = buildCostReport(
    [
      run({ totalBilledUsd: 0.4, totalListUsd: 0.4 }),
      run({ totalBilledUsd: 0.3, totalListUsd: 0.3, runId: "run-2" }),
      run({ runShape: "warmSameDay", totalBilledUsd: 0.12, totalListUsd: 0.12 }),
      run({ runShape: "warmSameDay", totalBilledUsd: 0.14, totalListUsd: 0.14 }),
      run({ route: "expand", runShape: "unknown", totalBilledUsd: 0.012, totalListUsd: 0.012 }),
      run({ isFloor: true, totalBilledUsd: 0.01 }),
    ],
    3
  );

  it("renders every headline figure in BOTH outputs", () => {
    // headlineFigures is the spec and is deliberately not called by either
    // renderer -- if it were, a renderer could drop a figure and the check
    // would agree with it. The markdown escapes dollars for Obsidian, so the
    // comparison accounts for that and nothing else.
    const markdown = renderCostMarkdown(report);
    const html = renderCostHtml(report);

    for (const figure of headlineFigures(report)) {
      expect({ figure, inHtml: html.includes(figure) }).toEqual({ figure, inHtml: true });
      const escaped = figure.replace(/\$/g, "\\$");
      expect({ figure, inMarkdown: markdown.includes(escaped) }).toEqual({
        figure,
        inMarkdown: true,
      });
    }
  });

  it("shows the same section count in both", () => {
    const markdown = renderCostMarkdown(report);
    const html = renderCostHtml(report);

    for (const section of report.sections) {
      expect(markdown).toContain(`## ${sectionTitle(section)}`);
      expect(html).toContain(`<h2>${sectionTitle(section)}</h2>`);
    }
  });

  it("states the not-a-trend caveat in both when a section has one usable run", () => {
    const thin = buildCostReport([run()]);

    expect(renderCostMarkdown(thin)).toContain("not a trend");
    expect(renderCostHtml(thin)).toContain("not a trend");
  });

  it("names the counted-but-not-averaged floor runs in both", () => {
    expect(renderCostMarkdown(report)).toContain("1 counted but not averaged");
    expect(renderCostHtml(report)).toContain("1 counted but not averaged");
  });

  it("names the unreadable lines in both", () => {
    expect(renderCostMarkdown(report)).toContain("3 unreadable");
    expect(renderCostHtml(report)).toContain("3 unreadable");
  });

  it("warns in both when the runs span two rate cards", () => {
    const spanning = buildCostReport([
      run({ pricingVerifiedOn: "2026-08-15" }),
      run({ pricingVerifiedOn: "2026-09-11" }),
    ]);

    expect(renderCostMarkdown(spanning)).toContain("more than one rate card");
    expect(renderCostHtml(spanning)).toContain("more than one rate card");
  });
});

describe("renderCostMarkdown: vault output rules", () => {
  const report = buildCostReport([run(), run({ runId: "run-2" })]);

  it("escapes every literal dollar sign", () => {
    // Obsidian pairs `$` across LINE BREAKS as math delimiters, so two
    // unescaped ones swallow every row between them and the table stops
    // rendering entirely.
    const markdown = renderCostMarkdown(report);

    for (const [index, char] of [...markdown].entries()) {
      if (char !== "$") continue;
      expect({ index, escaped: markdown[index - 1] === "\\" }).toEqual({ index, escaped: true });
    }
  });

  it("carries no generation timestamp, so an unchanged log is an empty diff", () => {
    // (C) COST.md is committed precisely so `git diff` is the trend history.
    // A timestamp would make every regeneration a diff even when no figure
    // moved. The run count and date range say the same thing and only change
    // when the data does.
    const markdown = renderCostMarkdown(report);

    expect(markdown).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(markdown).not.toMatch(/generated (on|at)\b/i);
    expect(renderCostMarkdown(report)).toBe(markdown);
  });

  it("puts a blank line around every table and heading", () => {
    const lines = renderCostMarkdown(report).split("\n");

    lines.forEach((line, i) => {
      if (line.startsWith("#")) {
        if (i > 0) expect({ line, before: lines[i - 1] }).toEqual({ line, before: "" });
        expect({ line, after: lines[i + 1] }).toEqual({ line, after: "" });
      }
      if (line.startsWith("|") && !lines[i - 1]?.startsWith("|")) {
        expect({ line, before: lines[i - 1] }).toEqual({ line, before: "" });
      }
    });
  });

  it("gives every table row the header's pipe count and a delimiter row", () => {
    const lines = renderCostMarkdown(report).split("\n");
    const tableStarts = lines
      .map((line, i) => (line.startsWith("| Measure") ? i : -1))
      .filter((i) => i >= 0);

    expect(tableStarts.length).toBeGreaterThan(0);
    for (const start of tableStarts) {
      const pipes = (lines[start].match(/\|/g) ?? []).length;
      expect(lines[start + 1]).toMatch(/^\|(-+\|)+$/);
      let row = start + 2;
      while (lines[row]?.startsWith("|")) {
        expect({ row, pipes: (lines[row].match(/\|/g) ?? []).length }).toEqual({ row, pipes });
        row += 1;
      }
    }
  });

  it("never hard-wraps a paragraph", () => {
    // One paragraph is one line, however long -- Obsidian soft-wraps, and a
    // hard wrap breaks sentences mid-clause in the editor.
    const prose = renderCostMarkdown(report)
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("|") && !line.startsWith("#"));

    expect(prose.length).toBeGreaterThan(0);
    for (const line of prose) {
      expect({ line, endsMidSentence: /[a-z,]$/.test(line) && line.length > 100 }).toEqual({
        line,
        endsMidSentence: false,
      });
    }
  });
});

describe("empty and degenerate inputs", () => {
  it("renders a report with no runs rather than crashing", () => {
    const report = buildCostReport([]);

    expect(report.totalRuns).toBe(0);
    expect(report.sections).toEqual([]);
    expect(renderCostMarkdown(report)).toContain("No runs recorded yet.");
    expect(renderCostHtml(report)).toContain("No runs recorded yet.");
  });

  it("renders a single-day range without repeating the date", () => {
    const report = buildCostReport([run(), run({ runId: "run-2" })]);
    expect(renderCostMarkdown(report)).toContain("2026-09-11.");
    expect(renderCostMarkdown(report)).not.toContain("2026-09-11 to 2026-09-11");
  });

  it("escapes HTML-significant characters in the HTML output", () => {
    const report = buildCostReport([run({ pricingVerifiedOn: "<script>x</script>" })]);
    const html = renderCostHtml(report);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("formats dollars through the same helper the console summary uses", () => {
    const report = buildCostReport([
      run({ totalBilledUsd: 0.335, totalListUsd: 0.335 }),
      run({ totalBilledUsd: 0.335, totalListUsd: 0.335, runId: "run-2" }),
    ]);

    expect(renderCostHtml(report)).toContain(formatUsd(0.335));
  });
});

describe("a record the report cannot place is skipped, never silently dropped", () => {
  // Review round 1, high severity. The validator checked `typeof runShape ===
  // "string"` while the grouping loop matched only the four real shapes, so a
  // record carrying anything else counted toward the headline "N runs", the
  // floor count and the date range -- and appeared in no section. The page's
  // own total disagreed with the sum of what it showed, with nothing saying
  // why. Reachable from a hand-edited or corrupted log, which this module
  // already anticipates elsewhere (it handles a truncated last line).
  it("refuses a runShape outside the known set", () => {
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify(run({ runShape: "lukewarm" as never })),
      JSON.stringify(run()),
    ]);

    expect(records).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("keeps the headline total equal to the sum of the sections", () => {
    // The invariant the bug broke, asserted directly rather than via its
    // symptoms -- this is what a reader of the rendered page relies on.
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify(run({ runShape: "lukewarm" as never })),
      JSON.stringify(run({ runShape: "cold" })),
      JSON.stringify(run({ runShape: "warmSameDay" })),
      JSON.stringify(run({ route: "expand", runShape: "unknown" })),
    ]);
    const report = buildCostReport(records, skipped);

    const summed = report.sections.reduce((total, section) => total + section.totalRuns, 0);
    expect(summed).toBe(report.totalRuns);
    expect(report.totalRuns).toBe(3);
    expect(report.skippedLines).toBe(1);
  });

  it("accepts every shape the app can actually write", () => {
    // The other half: the validator must not reject a legitimate shape, or
    // real runs would vanish into the skipped count instead.
    for (const runShape of ["cold", "warmNewDay", "warmSameDay", "unknown"] as const) {
      const { records, skipped } = parseUsageRunLines([JSON.stringify(run({ runShape }))]);
      expect({ runShape, kept: records.length, skipped }).toEqual({ runShape, kept: 1, skipped: 0 });
    }
  });
});

describe("malformed numbers are excluded, not summed", () => {
  // The type says `number | null`, but these records come off a file on disk.
  // A stray undefined or string passed the old `!== null` filter straight
  // into the sum and turned one bad field into a NaN mean for the section.
  it("excludes undefined, strings and NaN from a mean instead of poisoning it", () => {
    const report = buildCostReport([
      run({ cardsWritten: 8 }),
      run({ cardsWritten: undefined as never }),
      run({ cardsWritten: "12" as never }),
      run({ cardsWritten: NaN as never }),
    ]);

    const section = report.sections[0];
    expect(section.cardsWritten.mean).toBe(8);
    expect(section.cardsWritten.n).toBe(1);
    expect(Number.isNaN(section.cardsWritten.mean)).toBe(false);
  });

  it("rejects a record whose dollar total is not a finite number", () => {
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify({ ...run(), totalBilledUsd: "0.33" }),
      // JSON has no NaN literal, so this is how a corrupted figure arrives.
      JSON.stringify({ ...run(), totalListUsd: null }),
    ]);

    expect(records).toEqual([]);
    expect(skipped).toBe(2);
  });

  it("never renders NaN into either output", () => {
    const report = buildCostReport([run({ articleCount: undefined as never })]);

    expect(renderCostMarkdown(report)).not.toContain("NaN");
    expect(renderCostHtml(report)).not.toContain("NaN");
  });
});

describe("a nonzero cost is never rendered as free", () => {
  // usage.ts's formatUsd renders "<$0.000001" rather than "$0.000000"
  // precisely so a line cannot claim something was free when it wasn't. The
  // table cells bypassed that helper, so the same report showed "<\$0.000001"
  // in prose and "0.000000" in the table for the identical number.
  it("shows a sub-cent-fraction cost as a bound, not as zeros", () => {
    const report = buildCostReport([
      run({ totalBilledUsd: 0.0000003, totalListUsd: 0.0000003 }),
      run({ totalBilledUsd: 0.0000005, totalListUsd: 0.0000005, runId: "run-2" }),
    ]);

    const markdown = renderCostMarkdown(report);
    const html = renderCostHtml(report);

    expect(markdown).toContain("<0.000001");
    expect(html).toContain("<0.000001");
    expect(markdown).not.toContain("| 0.000000 |");
    expect(html).not.toContain("<td>0.000000</td>");
  });

  it("still shows a genuine zero as zero", () => {
    // The guard must not turn a real free run into a false lower bound.
    const report = buildCostReport([
      run({ totalBilledUsd: 0, totalListUsd: 0 }),
      run({ totalBilledUsd: 0, totalListUsd: 0, runId: "run-2" }),
    ]);

    expect(renderCostMarkdown(report)).toContain("0.000000");
    expect(renderCostMarkdown(report)).not.toContain("<0.000001");
  });
});

describe("the not-a-trend caveat covers every section below the threshold", () => {
  it("says it when a section has no usable runs at all", () => {
    // Zero is fewer than two. An earlier message here was arguably clearer
    // and did not contain the phrase, which made this the one section where
    // the rule silently did not apply.
    const report = buildCostReport([run({ isFloor: true }), run({ isFloor: true })]);

    expect(report.sections[0].isTrend).toBe(false);
    expect(renderCostMarkdown(report)).toContain("not a trend");
    expect(renderCostHtml(report)).toContain("not a trend");
  });
});

describe("record-derived strings cannot break the markdown", () => {
  it("neutralises a backtick that would escape an inline code span", () => {
    const report = buildCostReport([
      run({ pricingVerifiedOn: "2026-08-15" }),
      run({ pricingVerifiedOn: "2026-09-11`broken`" }),
    ]);

    const markdown = renderCostMarkdown(report);
    const rateCardLine = markdown.split("\n").find((l) => l.includes("more than one rate card"));

    expect(rateCardLine).toBeDefined();
    // Exactly the backticks the template puts there, none smuggled in.
    expect((rateCardLine!.match(/`/g) ?? []).length).toBe(4);
  });

  it("collapses a newline that would break the document's line structure", () => {
    const report = buildCostReport([run({ pricingVerifiedOn: "2026-09-11\n\n## Injected heading" })]);
    const markdown = renderCostMarkdown(report);

    // The text survives -- it is data and should be visible. What must not
    // happen is it starting a LINE, where markdown would read it as a real
    // heading and it would restructure the document.
    for (const line of markdown.split("\n")) {
      expect({ line, startsHeading: line.startsWith("## Injected") }).toEqual({
        line,
        startsHeading: false,
      });
    }
    expect(markdown).toContain("2026-09-11 ## Injected heading");
  });

  it("keeps the vault's structural rules under hostile input", () => {
    const report = buildCostReport([
      run({ pricingVerifiedOn: "a`b\nc" }),
      run({ pricingVerifiedOn: "2026-09-11", runId: "run-2" }),
    ]);
    const lines = renderCostMarkdown(report).split("\n");

    lines.forEach((line, i) => {
      if (line.startsWith("#") && i > 0) {
        expect({ line, before: lines[i - 1] }).toEqual({ line, before: "" });
      }
    });
  });
});

describe("the headline cannot disagree with the sections, whoever supplied the records", () => {
  // Round 2. The first fix put the guard in `isUsableRecord`, which protects
  // the ONE caller that goes through the parser. `buildCostReport` is the
  // exported reusable core -- the script's own comment anticipates a second
  // reader sourcing records from Supabase -- and called directly it still
  // counted an unplaceable record in `totalRuns` while no section held it.
  // The guarantee was enforced at a call site, not structurally.
  it("excludes an unplaceable record from the total when called directly", () => {
    const report = buildCostReport([
      run({ runShape: "lukewarm" as never }),
      run({ runShape: "cold" }),
    ]);

    const summed = report.sections.reduce((total, section) => total + section.totalRuns, 0);
    expect(report.totalRuns).toBe(1);
    expect(summed).toBe(report.totalRuns);
    expect(report.excludedRuns).toBe(1);
  });

  it("keeps an unplaceable record out of floorRuns and the date range too", () => {
    // Those were computed off the raw array, so an unplaceable record could
    // move the floor count and the reported dates while appearing nowhere.
    const report = buildCostReport([
      run({ runShape: "lukewarm" as never, isFloor: true, pricedAtIso: "2020-01-01T00:00:00.000Z" }),
      run({ runShape: "cold", pricedAtIso: "2026-09-11T12:00:00.000Z" }),
    ]);

    expect(report.floorRuns).toBe(0);
    expect(report.firstRunDate).toBe("2026-09-11");
  });

  it("says so in both outputs rather than dropping them silently", () => {
    const report = buildCostReport([
      run({ runShape: "lukewarm" as never }),
      run({ runShape: "cold" }),
    ]);

    expect(renderCostMarkdown(report)).toContain("1 rejected as unusable");
    expect(renderCostHtml(report)).toContain("1 rejected as unusable");
  });

  it("reports zero excluded for records that came through the parser", () => {
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify(run({ runShape: "lukewarm" as never })),
      JSON.stringify(run()),
    ]);
    const report = buildCostReport(records, skipped);

    // The parser already rejected it, so it is counted once -- as skipped,
    // not as unplaceable. Double-counting would overstate the loss.
    expect(report.excludedRuns).toBe(0);
    expect(report.skippedLines).toBe(1);
  });
});

describe("a dollar figure that cannot be real is refused, not rendered", () => {
  it("rejects a negative dollar total, matching the table's own CHECK constraint", () => {
    // supabase/schema.sql carries `check (total_billed_usd >= 0 ...)`. A log
    // line that violates it is corrupt, and averaging it would drag a mean
    // below what anything actually cost.
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify(run({ totalBilledUsd: -0.1 })),
      JSON.stringify(run({ totalListUsd: -0.1 })),
      JSON.stringify(run()),
    ]);

    expect(records).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("excludes a negative dollar total even when buildCostReport is called directly", () => {
    // REWRITTEN. This used to assert how a negative RENDERED, because a
    // negative could reach a table cell through a direct caller. It cannot
    // any more: one validator now runs on every path into the report, so a
    // negative never reaches a renderer. That is the stronger guarantee, and
    // the weaker test had to go rather than sit alongside it.
    const report = buildCostReport([
      run({ totalBilledUsd: -0.0000003, totalListUsd: -0.0000003 }),
      run({ runId: "run-2" }),
    ]);

    expect(report.excludedRuns).toBe(1);
    expect(report.totalRuns).toBe(1);
    expect(renderCostMarkdown(report)).not.toContain("-0.000000");
    expect(renderCostHtml(report)).not.toContain("-0.000000");
  });

  it("rejects a record whose pricingVerifiedOn is not a string", () => {
    // It reaches mdInline, which calls .replace() on it. Unvalidated, a
    // hand-edited numeric value threw a TypeError mid-render and took the
    // whole report down -- the opposite of surviving a malformed file.
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify({ ...run(), pricingVerifiedOn: 20260911 }),
      JSON.stringify({ ...run(), pricingVerifiedOn: null }),
    ]);

    expect(records).toEqual([]);
    expect(skipped).toBe(2);
  });

  it("excludes rather than throwing when a bad pricingVerifiedOn reaches buildCostReport directly", () => {
    // This test used to pass a perfectly valid "2026-09-11" while claiming to
    // cover the bad-value path, so it would have passed whether or not the bug
    // existed. Caught in review. The value below is the one that actually
    // crashed both renderers: mdInline and esc each call .replace() on it.
    const report = buildCostReport([
      run({ pricingVerifiedOn: 20260911 as never }),
      run({ runId: "run-2" }),
    ]);

    expect(report.excludedRuns).toBe(1);
    expect(report.pricingVerifiedOn).toEqual(["2026-09-11"]);
    expect(() => renderCostMarkdown(report)).not.toThrow();
    expect(() => renderCostHtml(report)).not.toThrow();
  });
});

describe("the table and the prose share one underflow threshold", () => {
  it("agrees with formatUsd about what is too small to print", () => {
    // The drift this guards: statUsd once hardcoded 0.000001 while formatUsd
    // read SMALLEST_SHOWN_USD. Changing the constant would have silently
    // reintroduced the table-says-free-prose-says-bound disagreement. Both
    // now read the same exported constant, and this asserts they still move
    // together rather than that either equals a literal.
    const justUnder = SMALLEST_SHOWN_USD / 2;
    const report = buildCostReport([
      run({ totalBilledUsd: justUnder, totalListUsd: justUnder }),
      run({ totalBilledUsd: justUnder, totalListUsd: justUnder, runId: "run-2" }),
    ]);

    const markdown = renderCostMarkdown(report);
    // formatUsd's own rendering of the same number, as it appears in prose.
    expect(markdown).toContain(formatUsd(justUnder).replace(/\$/g, "\\$"));
    // And the table cell agrees it is below the bound rather than zero.
    expect(markdown).toContain(`<${SMALLEST_SHOWN_USD.toFixed(6)}`);
    expect(markdown).not.toContain("| 0.000000 |");
  });
});

describe("the headline-equals-sections invariant holds for ANY unusable field", () => {
  // Written because this bug shape recurred across FIVE review rounds, each
  // round's test proving only what that round had just fixed. The full history
  // is narrated once, in `isUsableRecord`'s docstring in costReport.ts --
  // deliberately not repeated here, since keeping a second count in a second
  // place is exactly how the two versions of it drifted apart and had to be
  // corrected.
  //
  // So this asserts the PROPERTY the docstring claims, over every field
  // placement depends on, rather than one example per past incident. A new
  // field added to the validator without a matching case here will look
  // covered and not be -- but the direction that actually bit, a guard living
  // on one path and not another, is now structurally impossible: there is one
  // validator and every path runs it.
  // Generated rather than hand-picked. The previous six cases were chosen one
  // per past incident, which left a diagonal gap -- NaN was tested on `billed`
  // and Infinity on `list`, so neither was tested on the other. A cross
  // product cannot have that kind of corner.
  const badNumbers: { name: string; value: number }[] = [
    { name: "NaN", value: Number.NaN },
    { name: "Infinity", value: Number.POSITIVE_INFINITY },
    { name: "-Infinity", value: Number.NEGATIVE_INFINITY },
    { name: "negative", value: -0.1 },
  ];

  const unusable: { name: string; override: Partial<PublicUsageRunRecord> }[] = [
    { name: "unknown route", override: { route: "bogus-route" as never } },
    { name: "unknown runShape", override: { runShape: "lukewarm" as never } },
    // Fields the single validator covers that the partition used to miss.
    { name: "future schemaVersion", override: { schemaVersion: 2 as never } },
    { name: "non-boolean isFloor", override: { isFloor: "false" as never } },
    { name: "non-string pricingVerifiedOn", override: { pricingVerifiedOn: 20260911 as never } },
    // The fifth instance, and the only one that FABRICATED rather than lost:
    // new Date(1757600000000) is finite and renders as a plausible 2025-09-11.
    { name: "numeric pricedAtIso", override: { pricedAtIso: 1757600000000 as never } },
    { name: "boolean pricedAtIso", override: { pricedAtIso: true as never } },
    { name: "non-ISO pricedAtIso string", override: { pricedAtIso: "09/11/2026" } },
    { name: "negative totalCalls", override: { totalCalls: -1 } },
    { name: "NaN totalCalls", override: { totalCalls: Number.NaN } },
    ...badNumbers.flatMap(({ name, value }) => [
      { name: `${name} billed`, override: { totalBilledUsd: value } },
      { name: `${name} list`, override: { totalListUsd: value } },
    ]),
  ];

  for (const { name, override } of unusable) {
    it(`excludes and counts a record with an ${name}, called directly`, () => {
      // Direct call, bypassing parseUsageRunLines -- the channel the module's
      // own comments anticipate for a future Supabase-sourced reader, where
      // `route` is an unconstrained Postgres text column.
      const report = buildCostReport([run(override), run({ runId: "run-2" })]);
      const summed = report.sections.reduce((total, section) => total + section.totalRuns, 0);

      expect({ name, totalRuns: report.totalRuns, summed, excluded: report.excludedRuns }).toEqual({
        name,
        totalRuns: 1,
        summed: 1,
        excluded: 1,
      });
    });
  }

  it("says so in both outputs for every one of them", () => {
    for (const { name, override } of unusable) {
      const report = buildCostReport([run(override), run({ runId: "run-2" })]);
      expect({ name, inMarkdown: renderCostMarkdown(report).includes("1 rejected as unusable") }).toEqual({
        name,
        inMarkdown: true,
      });
      expect({ name, inHtml: renderCostHtml(report).includes("1 rejected as unusable") }).toEqual({
        name,
        inHtml: true,
      });
    }
  });

  it("places every record the app can actually produce", () => {
    // The other direction, and the one a too-strict guard would break: every
    // legitimate (route, runShape) combination must land in a section, or real
    // runs would vanish into the excluded count instead.
    const every = (["digest", "expand"] as const).flatMap((route) =>
      (["cold", "warmNewDay", "warmSameDay", "unknown"] as const).map((runShape) =>
        run({ route, runShape, runId: `${route}-${runShape}` })
      )
    );
    const report = buildCostReport(every);

    expect(report.excludedRuns).toBe(0);
    expect(report.totalRuns).toBe(every.length);
    expect(report.sections.reduce((t, s) => t + s.totalRuns, 0)).toBe(every.length);
  });
});

describe("every top-level figure is derived from the records actually shown", () => {
  // The family's last untested corner, found by mutation: `pricingVerifiedOn`
  // was correctly computed from the filtered set, but nothing asserted it, so
  // changing that one line to read the UNFILTERED array passed all 712 tests.
  // `totalRuns`, `floorRuns` and the date range each had a direct test; this
  // field did not.
  //
  // Written as a sweep over every top-level figure rather than one more
  // single-field test, because single-field tests are exactly what kept
  // leaving a next field uncovered.
  const excluded = run({
    runShape: "lukewarm" as never,
    isFloor: true,
    pricedAtIso: "1999-01-01T00:00:00.000Z",
    pricingVerifiedOn: "1999-01-01",
    totalBilledUsd: 999,
    totalListUsd: 999,
  });
  const kept = run({ runId: "kept", pricedAtIso: "2026-09-11T12:00:00.000Z" });

  it("leaves an excluded record out of every headline figure at once", () => {
    const report = buildCostReport([excluded, kept]);

    expect({
      totalRuns: report.totalRuns,
      floorRuns: report.floorRuns,
      excludedRuns: report.excludedRuns,
      firstRunDate: report.firstRunDate,
      lastRunDate: report.lastRunDate,
      pricingVerifiedOn: report.pricingVerifiedOn,
      sectionRuns: report.sections.reduce((total, section) => total + section.totalRuns, 0),
    }).toEqual({
      totalRuns: 1,
      floorRuns: 0,
      excludedRuns: 1,
      firstRunDate: "2026-09-11",
      lastRunDate: "2026-09-11",
      pricingVerifiedOn: ["2026-09-11"],
      sectionRuns: 1,
    });
  });

  it("does not let an excluded record's rate card trigger the multi-rate-card warning", () => {
    // The concrete harm of the untested line: a discarded record's
    // pricingVerifiedOn would make the report announce that its figures span
    // two rate cards when they do not.
    const report = buildCostReport([excluded, kept]);

    expect(renderCostMarkdown(report)).not.toContain("more than one rate card");
    expect(renderCostHtml(report)).not.toContain("more than one rate card");
  });
});

describe("a corrupted timestamp cannot become a plausible date", () => {
  // The fifth and worst instance of the family. Every earlier one made a
  // record VANISH from a figure; this one invented one. `utcDate` asked only
  // whether the resulting Date was finite, and `new Date(...)` coerces a
  // number through ToNumber -- so 1757600000000 does not fail, it renders as
  // 2025-09-11: a real-looking date, a year off the real data, shown as fact
  // in firstRunDate/lastRunDate.
  it("rejects a numeric pricedAtIso rather than coercing it into a date", () => {
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify(run({ pricedAtIso: 1757600000000 as never })),
      JSON.stringify(run({ pricedAtIso: true as never })),
      JSON.stringify(run()),
    ]);

    expect(records).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("never lets a coerced date reach a headline figure", () => {
    const report = buildCostReport([
      run({ pricedAtIso: 1757600000000 as never }),
      run({ runId: "run-2", pricedAtIso: "2026-09-11T12:00:00.000Z" }),
    ]);

    expect(report.excludedRuns).toBe(1);
    expect(report.firstRunDate).toBe("2026-09-11");
    expect(report.lastRunDate).toBe("2026-09-11");
    expect(renderCostMarkdown(report)).not.toContain("2025-09-11");
    expect(renderCostMarkdown(report)).not.toContain("1970-01-01");
  });

  it("still accepts a genuinely absent timestamp", () => {
    // null is a real, expected value -- it is what an unusable clock records,
    // and the guard must not turn that into a rejection.
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify(run({ pricedAtIso: null, clockUsable: false })),
    ]);

    expect(records).toHaveLength(1);
    expect(skipped).toBe(0);
    expect(buildCostReport(records).firstRunDate).toBeNull();
  });
});

describe("a count that cannot be real is dropped from its statistic", () => {
  // Found in round 6. `cardsWritten` and `articleCount` are nullable, so they
  // are validated at point of use rather than by `isUsableRecord` -- and
  // `sampleStat` filtered on finite-ness without ever checking sign. A record
  // with `cardsWritten: -5` beside one with 8 rendered "Cards written | 1.5",
  // silently, with no exclusion notice anywhere.
  //
  // Every quantity this report summarises is a cost or a count, and neither
  // can be negative, so the filter is uniform rather than a special case.
  it("excludes a negative count from the mean instead of averaging it", () => {
    const report = buildCostReport([
      run({ cardsWritten: 8, articleCount: 100 }),
      run({ runId: "run-2", cardsWritten: -5, articleCount: -100 }),
    ]);

    const section = report.sections[0];
    expect(section.cardsWritten.mean).toBe(8);
    expect(section.cardsWritten.n).toBe(1);
    expect(section.articleCount.mean).toBe(100);
    expect(section.articleCount.n).toBe(1);
  });

  it("keeps the RECORD, dropping only the bad field", () => {
    // One corrupt optional field is not grounds to discard a run's cost, which
    // is measured independently and still trustworthy.
    const report = buildCostReport([
      run({ cardsWritten: 8 }),
      run({ runId: "run-2", cardsWritten: -5, totalBilledUsd: 0.4, totalListUsd: 0.4 }),
    ]);

    expect(report.totalRuns).toBe(2);
    expect(report.excludedRuns).toBe(0);
    expect(report.sections[0].billedUsd.n).toBe(2);
  });

  it("never renders a negative mean", () => {
    const report = buildCostReport([
      run({ cardsWritten: -5, articleCount: -100 }),
      run({ runId: "run-2", cardsWritten: -5, articleCount: -100 }),
    ]);

    expect(renderCostMarkdown(report)).not.toMatch(/\|\s*-\d/);
    expect(renderCostHtml(report)).not.toMatch(/<td>-\d/);
  });

  it("still counts a legitimate zero", () => {
    // The guard must not turn "wrote no cards" into "never measured".
    const report = buildCostReport([
      run({ cardsWritten: 0 }),
      run({ runId: "run-2", cardsWritten: 4 }),
    ]);

    expect(report.sections[0].cardsWritten.mean).toBe(2);
    expect(report.sections[0].cardsWritten.n).toBe(2);
  });
});

describe("a corrupted timestamp STRING cannot become a plausible date either", () => {
  // The milder half of the fifth instance. Type-checking alone left
  // `new Date("09/11/2026")` parsing to a real date; only a shape check
  // rejects it.
  it("rejects a non-ISO date string", () => {
    const { records, skipped } = parseUsageRunLines([
      JSON.stringify(run({ pricedAtIso: "09/11/2026" })),
      JSON.stringify(run({ pricedAtIso: "yesterday" })),
      JSON.stringify(run()),
    ]);

    expect(records).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("accepts every shape the app itself can emit", () => {
    // Over-rejection would shrink the sample silently, which is the worse of
    // the two failures -- so this pins the real producer's output plus the
    // ISO variants the pattern deliberately allows.
    const accepted = [
      new Date("2026-09-11T12:00:00.000Z").toISOString(),
      "2026-09-11T12:00:00Z",
      "2026-09-11T12:00:00+02:00",
      "2026-09-11T12:00:00.123456Z",
    ];

    for (const pricedAtIso of accepted) {
      const { records, skipped } = parseUsageRunLines([JSON.stringify(run({ pricedAtIso }))]);
      expect({ pricedAtIso, kept: records.length, skipped }).toEqual({
        pricedAtIso,
        kept: 1,
        skipped: 0,
      });
    }
  });
});
