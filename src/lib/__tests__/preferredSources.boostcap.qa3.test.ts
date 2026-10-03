import { describe, it, expect } from "vitest";
import { applyCardCap, TOP_UP_CARDS_PER_TOPIC, type CardCapOptions } from "@/lib/cardCap";
import { boostPreferredClusters, MAX_SEVERITY, PREFERRED_SEVERITY_BOOST } from "@/lib/preferredSources";
import { SOURCES, TOPICS, type Cluster, type Source, type Topic } from "@/types";

// QA round 3: the boost and the card cap composed the way the digest route
// composes them (boost the triaged list, then cap the notable ones with the
// same preferences). Never names a topic or an outlet.

const TOPIC = TOPICS[0] as Topic;
const [PICKED, PICKED_TOO, OTHER] = SOURCES.slice(0, 3) as Source[];
const PREFERRED = [PICKED, PICKED_TOO];
const TOP_UP: CardCapOptions = { runShape: "sameDayTopUp", existingCards: [] };

function triaged(label: string, severity: number, sources: Source[], notable = true) {
  const cluster: Cluster = {
    topic: TOPIC,
    articles: sources.map((source, i) => ({
      title: `${label}-${i}`,
      snippet: "",
      url: `https://example.com/${label}/${i}`,
      source,
      topic: TOPIC,
      publishedAt: "2026-10-02T12:00:00Z",
    })),
  };
  return { label, cluster, notable, severity };
}

/** The route's sequence: boost, keep the notable ones, cap with the same preferences. */
function pipeline(items: ReturnType<typeof triaged>[], preferred: Source[]) {
  const { items: boosted } = boostPreferredClusters(items, preferred);
  return applyCardCap(
    boosted.filter((i) => i.notable),
    { ...TOP_UP, preferredSources: preferred }
  ).kept.map((k) => k.label);
}

describe("boost then cap", () => {
  it("assumes the constants this file was written against", () => {
    expect(TOP_UP_CARDS_PER_TOPIC).toBe(2);
    expect(MAX_SEVERITY).toBe(5);
    expect(PREFERRED_SEVERITY_BOOST).toBe(1);
  });

  it("lets a preferred severity-4 story win a slot over non-preferred severity-5 ones (the boost's purpose)", () => {
    const input = [triaged("top-a", 5, [OTHER]), triaged("top-b", 5, [OTHER]), triaged("pref4", 4, [PICKED])];
    expect(pipeline(input, PREFERRED)).toEqual(["top-a", "pref4"]);
  });

  it("with no preferences, keeps the two most severe exactly as before", () => {
    const input = [triaged("five", 5, [PICKED]), triaged("four-a", 4, [PICKED, PICKED_TOO, OTHER]), triaged("four-b", 4, [OTHER])];
    expect(pipeline(input, [])).toEqual(["five", "four-a"]);
  });

  // Both stories carry a preferred outlet, so the boost is meant to treat
  // them alike. Capping at MAX_SEVERITY turns 5 and 4 into 5 and 5, and the
  // next tie-break (preferred-outlet count, then article count) can then
  // drop the more severe story.
  it("never drops a severity-5 preferred story for severity-4 stories with more preferred outlets", () => {
    const input = [
      triaged("sev5-pref", 5, [PICKED]),
      triaged("sev4-pref-a", 4, [PICKED, PICKED_TOO]),
      triaged("sev4-pref-b", 4, [PICKED_TOO, PICKED]),
    ];
    expect(pipeline(input, PREFERRED)).toContain("sev5-pref");
  });

  it("never drops a severity-5 preferred story for severity-4 preferred stories with more articles", () => {
    const input = [
      triaged("sev5-pref", 5, [PICKED]),
      triaged("sev4-pref-a", 4, [PICKED, OTHER, OTHER]),
      triaged("sev4-pref-b", 4, [PICKED, OTHER]),
    ];
    expect(pipeline(input, PREFERRED)).toContain("sev5-pref");
  });
});
