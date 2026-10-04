import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, type Card, type Cluster, type Source, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import type { TriageVerdict } from "@/lib/triage";
import { recordCall } from "@/lib/usageCollector";
import { triageBatchCount } from "@/lib/triage";
import { readingUnits } from "@/lib/readingUnits";
import { applyCardCap } from "@/lib/cardCap";
import { boostPreferredClusters } from "@/lib/preferredSources";

// The merge-after-cap guarantee, checked against the real route over
// random scenarios. Two runs per scenario, same clusters and grades:
//   baseline: no event sentences, so boost -> cap -> write, as before the check;
//   merged:   sentences present, Haiku answers "same" exactly per ground truth.
// Every story the baseline writes must be written by the merged run, as itself
// or inside its keeper, and nothing else may appear.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestUnits: vi.fn(),
  clusterArticles: vi.fn(),
  filterAlreadyCovered: vi.fn(),
  triageClusters: vi.fn(),
  writeCard: vi.fn(),
  rankFrontPage: vi.fn(),
  upsertDigestForToday: vi.fn(),
  getLatestGeneratedAtForUser: vi.fn(),
  saveGeneratedCards: vi.fn(),
  claimGenerationForUser: vi.fn(),
  releaseGenerationClaim: vi.fn(),
  getTodaysCardSummaries: vi.fn(),
  defaultUsageSinks: vi.fn(),
  parse: vi.fn(),
  embed: vi.fn(),
  lookalike: new Set<string>(),
}));

vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({
      status: "ok",
      reservation: { id: "reservation-id", token: "settle-token", reservedUsd: 0.7 },
    })),
    settleSpend: vi.fn(async () => true),
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest")>()),
  ingestUnits: mocks.ingestUnits,
}));
vi.mock("@/lib/cluster", () => ({ clusterArticles: mocks.clusterArticles }));
vi.mock("@/lib/dedup", () => ({ filterAlreadyCovered: mocks.filterAlreadyCovered }));
vi.mock("@/lib/triage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/triage")>("@/lib/triage");
  return { triageClusters: mocks.triageClusters, triageBatchCount: actual.triageBatchCount };
});
vi.mock("@/lib/writeCard", () => ({ writeCard: mocks.writeCard }));
vi.mock("@/lib/rank", () => ({ rankFrontPage: mocks.rankFrontPage }));
vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: mocks.upsertDigestForToday,
  getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
  saveGeneratedCards: mocks.saveGeneratedCards,
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
}));
vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: mocks.claimGenerationForUser,
  releaseGenerationClaim: mocks.releaseGenerationClaim,
}));
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mocks.parse }, maxRetries: 0 };
  }
  return { default: FakeAnthropic };
});
// A sentence reads "Event E<id> told by <label>."; its vector is [id, label].
// Same id scores 0.8; a "lookalike" pair of different ids 0.6 (sent to Haiku,
// which refuses it); anything else 0.2.
vi.mock("@/lib/embeddings", () => ({
  embed: mocks.embed,
  cosineSimilarity: (a: [number, string], b: [number, string]) => {
    if (a[0] === b[0]) return 0.8;
    const key = a[0] < b[0] ? `${a[0]}|${b[0]}` : `${b[0]}|${a[0]}`;
    return mocks.lookalike.has(key) ? 0.6 : 0.2;
  },
}));

const [PICKED, ...OTHERS] = SOURCES as readonly Source[];
const TOPICS_PICKED: Topic[] = ["Geopolitics", "Defense & Security", "Football", "Countries" as Topic];
const COUNTRIES_PICKED = ["Kenya", "Morocco"];
const UNITS = readingUnits(TOPICS_PICKED, COUNTRIES_PICKED).read;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Story {
  label: string;
  cluster: Cluster;
  verdict: TriageVerdict;
  eventId: number;
  position: number;
}

function scenario(seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const stories: Story[] = [];
  const eventPool = 3 + Math.floor(r() * 10);
  const perUnitMax = r() < 0.5 ? 12 : 5;
  // Interleave units so input order is not grouped by unit.
  const slots: number[] = [];
  UNITS.forEach((_, u) => {
    const n = Math.floor(r() * (perUnitMax + 1));
    for (let k = 0; k < n; k += 1) slots.push(u);
  });
  slots.sort(() => r() - 0.5);
  slots.forEach((u, position) => {
    const unit = UNITS[u];
    const label = `s${position}`;
    const sourceCount = 1 + Math.floor(r() * 3);
    const sources = Array.from({ length: sourceCount }, () => (r() < 0.3 ? PICKED : pick(OTHERS)));
    const cluster: Cluster = {
      topic: unit.topic,
      ...(unit.subtopic ? { subtopic: unit.subtopic } : {}),
      articles: sources.map((source, i) => ({
        title: i === 0 ? label : `${label} (${i})`,
        snippet: "",
        url: `https://example.com/${label}/${i}`,
        source,
        topic: unit.topic,
        ...(unit.subtopic ? { subtopic: unit.subtopic } : {}),
        publishedAt: "2026-10-03T12:00:00Z",
      })),
    };
    const eventId = Math.floor(r() * eventPool);
    const notable = r() < 0.75;
    const severity = 1 + Math.floor(r() * 5);
    const hasEvent = notable && r() < 0.88;
    stories.push({
      label,
      cluster,
      eventId,
      position,
      verdict: {
        notable,
        severity,
        ...(hasEvent ? { event: `Event E${eventId} told by ${label}.` } : {}),
      },
    });
  });
  const lookalike = new Set<string>();
  for (let a = 0; a < eventPool; a += 1)
    for (let b = a + 1; b < eventPool; b += 1) if (r() < 0.3) lookalike.add(`${a}|${b}`);
  const topUp = r() < 0.4;
  const existing = topUp
    ? Array.from({ length: 1 + Math.floor(r() * 12) }, (_, i) => {
        const unit = pick(UNITS);
        return {
          id: `existing-${i}`,
          topic: unit.topic,
          subtopic: unit.subtopic,
          shortSummary: `old ${i}`,
          severity: 3,
          sources: [],
        };
      })
    : [];
  return { stories, lookalike, topUp, existing };
}

const billed = { usage: { input_tokens: 1000, output_tokens: 100 } };

function cardFor(c: Cluster, severity: number): Card {
  return {
    id: `card-${c.articles[0].title}`,
    topic: c.topic,
    title: c.articles[0].title,
    shortSummary: `summary ${c.articles[0].title}`,
    labels: ["Tag"],
    expandedReport: null,
    sources: c.articles.map(({ title, url, source, snippet }) => ({ title, url, source, snippet })),
    publishedAt: "2026-10-03T12:00:00Z",
    generatedAt: "overwritten-by-route",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

const labelOf = (title: string) => title.replace(/ \(\d+\)$/, "");
const eventIdOf = (line: string) => Number(/Event E(\d+) /.exec(line)![1]);

let emitted: UsageRunRecord[];
let logged: string[];

beforeEach(() => {
  emitted = [];
  logged = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: TOPICS_PICKED,
    preferredSources: [PICKED],
    countries: COUNTRIES_PICKED,
    timeZone: "UTC",
  });
  mocks.ingestUnits.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) => {
    await recordCall("writeCard", "claude-sonnet-5", async () => billed);
    return cardFor(c, severity);
  });
  mocks.rankFrontPage.mockImplementation(async () => {
    await recordCall("rank", "claude-haiku-4-5", async () => billed);
    return null;
  });
  mocks.embed.mockImplementation(async (texts: string[]) => texts.map((t) => [eventIdOf(t), t]));
  // Ground-truth Haiku: "same" exactly when both sentences name one event.
  mocks.parse.mockImplementation(async (params: { messages: { content: string }[] }) => {
    const blocks = params.messages[0].content.split(/\n\n(?=\d+\.\n)/);
    const verdicts = blocks
      .map((block) => {
        const m = /^(\d+)\.\nA: (.*)\n(?:.*\n)?B: (.*)/m.exec(block.replace(/^Pairs:\n\n/, ""));
        if (!m) return null;
        return { pair: Number(m[1]), same: eventIdOf(m[2]) === eventIdOf(m[3]) };
      })
      .filter((v): v is { pair: number; same: boolean } => v !== null);
    return { parsed_output: { verdicts }, stop_reason: "end_turn", ...billed };
  });
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runOnce(s: ReturnType<typeof scenario>, withEvents: boolean) {
  emitted = [];
  logged = [];
  mocks.writeCard.mockClear();
  mocks.parse.mockClear();
  mocks.embed.mockClear();
  mocks.lookalike.clear();
  for (const k of s.lookalike) mocks.lookalike.add(k);
  mocks.getLatestGeneratedAtForUser.mockResolvedValue(s.topUp ? new Date(Date.now() - 60_000).toISOString() : null);
  mocks.getTodaysCardSummaries.mockResolvedValue(s.existing);
  mocks.clusterArticles.mockResolvedValue(s.stories.map((st) => st.cluster));
  const verdicts: TriageVerdict[] = s.stories.map((st) =>
    withEvents ? st.verdict : { notable: st.verdict.notable, severity: st.verdict.severity }
  );
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) => {
    for (let i = 0; i < triageBatchCount(cs); i += 1) await recordCall("triage", "claude-haiku-4-5", async () => billed);
    return verdicts;
  });
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const text = await res.text();
  const events = text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { stage: string; notableCount?: number });
  expect(emitted).toHaveLength(1);
  const writes = (mocks.writeCard.mock.calls as [Cluster, number][]).map(([c, severity]) => ({ c, severity }));
  return { record: emitted[0], writes, events, logs: [...logged] };
}

function unitRank(c: Cluster) {
  return UNITS.findIndex((u) => u.topic === c.topic && (u.subtopic ?? null) === (c.subtopic ?? null));
}

describe("merging after the cap never changes what the cap decided", () => {
  it("over 400 random scenarios, every baseline story is written once, as itself or in its keeper, and nothing else", async () => {
    let totalMerged = 0;
    let scenariosWithCut = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const s = scenario(seed);
      const byLabel = new Map(s.stories.map((st) => [st.label, st]));

      const base = await runOnce(s, false);
      expect(mocks.embed, `seed ${seed}: no sentences must embed nothing`).not.toHaveBeenCalled();
      expect(mocks.parse).not.toHaveBeenCalled();
      const baseLabels = base.writes.map((w) => w.c.articles[0].title);
      // The baseline is the old pipeline, computed independently of the route:
      // boost, then the cap, nothing merged.
      const { items: boostedItems } = boostPreferredClusters(
        s.stories.map((st) => ({ cluster: st.cluster, notable: st.verdict.notable, severity: st.verdict.severity, label: st.label })),
        [PICKED]
      );
      const reference = applyCardCap(boostedItems.filter((t) => t.notable), {
        runShape: s.topUp ? "sameDayTopUp" : "firstEver",
        existingCards: s.existing,
        preferredSources: [PICKED],
      });
      expect(baseLabels, `seed ${seed}: route without sentences differs from boost + cap`).toEqual(
        reference.kept.map((k) => k.label)
      );
      // Baseline writes each story whole, at triage's own grade.
      for (const w of base.writes) {
        expect(new Set(w.c.articles.map((a) => labelOf(a.title))).size).toBe(1);
        expect(w.severity).toBe(byLabel.get(w.c.articles[0].title)!.verdict.severity);
      }

      const merged = await runOnce(s, true);
      const ctx = `seed ${seed}`;

      // 1. Coverage: the union of the merged run's members is exactly the baseline set, no story twice.
      const membersOf = merged.writes.map((w) => [...new Set(w.c.articles.map((a) => labelOf(a.title)))]);
      const flat = membersOf.flat();
      expect(new Set(flat).size, `${ctx}: a story written twice`).toBe(flat.length);
      expect([...flat].sort(), `${ctx}: written set differs from the cap's own`).toEqual([...baseLabels].sort());

      merged.writes.forEach((w, k) => {
        const members = membersOf[k].map((l) => byLabel.get(l)!);
        const keeper = byLabel.get(w.c.articles[0].title)!;
        // 2. One event per card.
        expect(new Set(members.map((m) => m.eventId)).size, `${ctx}: two events merged`).toBe(1);
        if (members.length > 1) {
          // Every merged member had a sentence.
          for (const m of members) expect(m.verdict.event, ctx).toBeDefined();
        }
        // 3. Written at triage's own grade: the group's highest.
        expect(w.severity, `${ctx}: written grade`).toBe(Math.max(...members.map((m) => m.verdict.severity)));
        // 4. Keeper: higher triage grade, then more articles, then earlier unit, then earlier position.
        const best = [...members].sort(
          (x, y) =>
            y.verdict.severity - x.verdict.severity ||
            y.cluster.articles.length - x.cluster.articles.length ||
            unitRank(x.cluster) - unitRank(y.cluster) ||
            x.position - y.position
        )[0];
        expect(keeper.label, `${ctx}: keeper`).toBe(best.label);
        expect(w.c.topic).toBe(keeper.cluster.topic);
        expect(w.c.subtopic ?? null).toBe(keeper.cluster.subtopic ?? null);
        // The keeper's own articles come first, in its own order.
        expect(w.c.articles.slice(0, keeper.cluster.articles.length).map((a) => a.url)).toEqual(
          keeper.cluster.articles.map((a) => a.url)
        );
      });

      // 5. The counts agree with what writeCard was asked for.
      const absorbed = baseLabels.length - merged.writes.length;
      totalMerged += absorbed;
      expect(merged.record.clustersMerged, ctx).toBe(absorbed);
      expect(merged.record.notableCount, ctx).toBe(merged.writes.length);
      expect(merged.record.cardsDroppedByCap, ctx).toBe(base.record.cardsDroppedByCap);
      if ((base.record.cardsDroppedByCap ?? 0) > 0) scenariosWithCut += 1;
      expect(merged.record.clustersBoosted, ctx).toBe(base.record.clustersBoosted);
      const writing = merged.events.find((e) => e.stage === "writing");
      expect(writing?.notableCount, `${ctx}: "Writing N cards"`).toBe(merged.writes.length);
      expect(base.record.clustersMerged, ctx).toBe(0);
      expect(base.record.notableCount, ctx).toBe(base.writes.length);
      // Expected calls match recorded calls in every stage, both directions.
      for (const r of [base, merged]) {
        expect(r.record.isFloor, ctx).toBe(false);
        const mismatch = r.logs.filter((l) => /made \d+ calls for \d+|recorded \d+ calls but \d+ were expected/.test(l));
        expect(mismatch, ctx).toEqual([]);
      }
      // Merge stage: one call exactly when some pair cleared the threshold.
      const mergeCalls = merged.record.stages
        .filter((g) => g.stage === "merge")
        .reduce((n, g) => n + g.calls + g.callsWithoutUsage, 0);
      expect(mergeCalls, ctx).toBe(mocks.parse.mock.calls.length);
      expect(mergeCalls).toBeLessThanOrEqual(1);
    }
    // The generator must actually exercise merges and cuts.
    expect(totalMerged).toBeGreaterThan(200);
    expect(scenariosWithCut).toBeGreaterThan(50);
  }, 120_000);
});
