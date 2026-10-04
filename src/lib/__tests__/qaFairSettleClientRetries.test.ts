import { describe, it, expect, vi, afterEach } from "vitest";

// Every page "blocked": the writer gets exactly the snippet-only prompt, and
// nothing in this file can reach the live web.
vi.mock("@/lib/extract", async (importOriginal) => {
  const blocked = async (urls: readonly string[]) =>
    urls.map((url) => ({ url, ok: false as const, reason: "robots" as const }));
  return {
    ...(await importOriginal<typeof import("@/lib/extract")>()),
    extractArticles: blocked,
    extractForStory: blocked,
  };
});

// QA (review-loop round 2, v2.4-fair-settle). The attempt count is read from
// the client, not hardcoded: give the real SDK client a different maxRetries
// and the bound must follow the number of HTTP requests actually sent.

const AT = new Date("2026-10-03T12:00:00Z");

async function loadWith(maxRetries: number | undefined) {
  vi.resetModules();
  vi.doMock("@anthropic-ai/sdk", async () => {
    const actual = await vi.importActual<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk");
    class Sized extends actual.default {
      constructor(opts?: ConstructorParameters<typeof actual.default>[0]) {
        super({ ...opts, ...(maxRetries === undefined ? {} : { maxRetries }) });
        if (maxRetries === undefined) (this as { maxRetries: unknown }).maxRetries = undefined;
      }
    }
    return { ...actual, default: Sized };
  });
  return {
    collector: await import("@/lib/usageCollector"),
    dedup: await import("@/lib/dedup"),
    usageRecord: await import("@/lib/usageRecord"),
    writeCard: await import("@/lib/writeCard"),
    cards: await import("@/lib/cards"),
    rank: await import("@/lib/rank"),
    triage: await import("@/lib/triage"),
  };
}

let sends = 0;

function stub500() {
  vi.stubEnv("ANTHROPIC_API_KEY", "qa-not-a-real-key");
  vi.stubEnv("ANTHROPIC_BASE_URL", "http://qa.invalid");
  sends = 0;
  vi.stubGlobal("fetch", async () => {
    sends += 1;
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "qa" } }), {
      status: 500,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    });
  });
}

afterEach(() => {
  vi.doUnmock("@anthropic-ai/sdk");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the bound's attempt count follows the client's real retry setting", () => {
  it.each([0, 1, 4])("maxRetries=%s", async (maxRetries) => {
    stub500();
    const m = await loadWith(maxRetries);
    const c = m.collector.createUsageCollector(AT);
    await m.collector.withUsageCollector(c, () => m.dedup.isSameStory("candidate", "existing"));
    expect(sends).toBe(maxRetries + 1);
    expect(c.calls()).toHaveLength(1);
    expect(c.calls()[0].bound?.attempts).toBe(sends);
  });

  type Mods = Awaited<ReturnType<typeof loadWith>>;
  const article = (i: number) => ({ title: `T${i}`, snippet: "s", url: `https://e.com/${i}`, source: "BBC", topic: "Tech/AI", publishedAt: "2026-10-03T10:00:00Z" });
  const sites: [string, (m: Mods) => Promise<unknown>][] = [
    ["writeCard (Haiku)", (m) => m.writeCard.writeCard({ topic: "Tech/AI", articles: [article(0)] } as never, 3)],
    ["writeCard (Sonnet)", (m) => m.writeCard.writeCard({ topic: "Tech/AI", articles: [0, 1, 2, 3].map(article) } as never, 3)],
    ["expand", (m) => m.cards.generateExpandedReport({ topic: "Tech/AI", shortSummary: "s", sources: [{ title: "T", url: "https://e.com", source: "BBC", snippet: "S" }] } as never)],
    ["rank", (m) => m.rank.rankFrontPage([{ topic: "Tech/AI", severity: 3, text: "a" }, { topic: "Tech/AI", severity: 2, text: "b" }] as never)],
    ["triage", (m) => m.triage.triageClusters([{ topic: "Tech/AI", articles: [article(0)] } as never])],
  ];

  it.each(sites)("every call site reads the client: %s with maxRetries=4", async (_label, fn) => {
    stub500();
    const m = await loadWith(4);
    const c = m.collector.createUsageCollector(AT);
    await m.collector.withUsageCollector(c, () => fn(m).catch(() => undefined));
    const calls = c.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(sends).toBe(5 * calls.length);
    for (const call of calls) expect(call.bound?.attempts).toBe(5);
  });

  it("a client with no numeric maxRetries records no bound, so the run keeps its reservation", async () => {
    stub500();
    const m = await loadWith(undefined);
    const c = m.collector.createUsageCollector(AT);
    await m.collector.withUsageCollector(c, () => m.dedup.isSameStory("candidate", "existing"));
    expect(c.calls()).toHaveLength(1);
    expect(c.calls()[0].bound).toBeUndefined();
    expect(m.usageRecord.settleCeilingFor(c.summarize(), { dedup: 1 })).toBeNull();
  });
});
