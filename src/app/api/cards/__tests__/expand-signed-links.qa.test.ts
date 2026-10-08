import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// QA (v2.6.3): the expand route end to end, with the real cards.ts,
// sourceLinks.ts and extract.ts against a fake web and fake DNS. Proves no
// unsigned, forged or replayed link stored on a card row is ever requested,
// and that the writer's signatures survive a jsonb-style round trip.

vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => [
    { address: host === "inside.example" ? "169.254.169.254" : "93.184.216.34", family: 4 },
  ];
  return { lookup, default: { lookup } };
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { SOURCES, TOPICS, type Cluster, type Source, type Topic } from "@/types";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  select: vi.fn(),
  rpc: vi.fn(),
  parse: vi.fn(),
  defaultUsageSinks: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mocks.parse } };
  }
  return { default: FakeAnthropic };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: () => ({
      select: (cols: string) => {
        mocks.select(cols);
        return { eq: () => ({ maybeSingle: mocks.maybeSingle }) };
      },
    }),
  })),
}));
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({
      status: "ok",
      reservation: { id: "reservation-1", token: "t".repeat(64), reservedUsd: 0.12 },
    })),
    settleSpend: vi.fn(async () => true),
  };
});
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

import { POST } from "@/app/api/cards/[id]/expand/route";
import { writeCard } from "@/lib/writeCard";
import { signSourceLink } from "@/lib/sourceLinks";
import { resetExtractStateForTests } from "@/lib/extract";

const ARTICLE = readFileSync(path.join(__dirname, "../../../../lib/__tests__/fixtures/extract/article.html"), "utf8");
const SECRET = "qa-source-link-secret-0123456789abcdef01234567";
const TOPIC = TOPICS[0] as Topic;
const SRC = SOURCES.slice(0, 8) as Source[];
const CARD_ID = "11111111-2222-4333-8444-555555555555";

// Every page on a public host serves the article; robots.txt is absent.
// redirect.example 302s to whatever its path says.
function fakeWeb() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
    if (u.hostname === "redirect.example") {
      return new Response(null, { status: 302, headers: { location: decodeURIComponent(u.searchParams.get("to") ?? "") } });
    }
    return new Response(ARTICLE, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

const requested = () => vi.mocked(fetch).mock.calls.map((c) => String(c[0] instanceof Request ? c[0].url : c[0]));
const reportPrompt = () => {
  const call = mocks.parse.mock.calls.find((c) => c[0].max_tokens === 4096);
  return call![0].messages[0].content as string;
};

function src(i: number, url: string, sig?: unknown) {
  return { title: `Title ${i}`, url, source: SRC[i], snippet: `Snippet ${i}`, ...(sig === undefined ? {} : { sig }) };
}

async function expandWith(sources: unknown) {
  mocks.maybeSingle.mockResolvedValue({
    data: { id: CARD_ID, topic: TOPIC, short_summary: "A short summary.", expanded_report: null, sources },
    error: null,
  });
  return POST(new Request("http://localhost/api/cards/x/expand", { method: "POST" }), {
    params: Promise.resolve({ id: CARD_ID }),
  });
}

beforeEach(() => {
  vi.stubEnv("SOURCE_LINK_SECRET", SECRET);
  resetExtractStateForTests();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.defaultUsageSinks.mockReturnValue([async () => {}]);
  mocks.parse.mockImplementation(async (params: { max_tokens: number }) =>
    params.max_tokens === 4096
      ? { parsed_output: { report: "A full report." }, stop_reason: "end_turn" }
      : { parsed_output: { title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] }, stop_reason: "end_turn" }
  );
  vi.stubGlobal("fetch", fakeWeb());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("expand route: only signed links are fetched (QA)", () => {
  it("selects the sources column, which carries sig", async () => {
    await expandWith([]);
    expect(mocks.select).toHaveBeenCalledWith(expect.stringContaining("sources"));
  });

  it("a writer-signed card survives a jsonb round trip and its page is fetched", async () => {
    const cluster: Cluster = {
      topic: TOPIC,
      articles: [
        { title: "A", snippet: "Snip A", url: "https://pub-a.example/story", source: SRC[0], topic: TOPIC, publishedAt: "2026-10-02T10:00:00Z" },
        { title: "B", snippet: "Snip B", url: "https://pub-b.example/story", source: SRC[1], topic: TOPIC, publishedAt: "2026-10-02T11:00:00Z" },
      ],
    };
    const card = await writeCard(cluster, 3);
    expect(card.sources.every((s) => typeof s.sig === "string" && s.sig.length === 43)).toBe(true);
    vi.mocked(fetch).mockClear();
    // jsonb keeps every key and every string byte for byte; key order may change.
    const fromDb = JSON.parse(JSON.stringify(card.sources.map((s) => Object.fromEntries(Object.entries(s).reverse()))));
    const res = await expandWith(fromDb);
    expect(res.status).toBe(200);
    expect(requested()).toContain("https://pub-a.example/story");
    expect(requested()).toContain("https://pub-b.example/story");
    expect(reportPrompt()).toContain("Full-text articles");
  });

  it("never requests unsigned, forged, cross-signed, wrong-secret or wrong-type-sig links", async () => {
    const good = "https://pub-a.example/story";
    const goodSig = signSourceLink(good, SECRET);
    const sources = [
      src(0, "https://attacker.example/unsigned"),
      src(1, good, goodSig),
      src(2, "https://attacker.example/forged", "A".repeat(43)),
      src(3, "https://attacker.example/replayed", goodSig),
      src(4, "https://attacker.example/othersecret", signSourceLink("https://attacker.example/othersecret", `${SECRET}x`)),
      src(5, "https://attacker.example/objsig", { toString: "x" }),
      src(6, "https://attacker.example/arrsig", [signSourceLink("https://attacker.example/arrsig", "nope")]),
      src(7, "https://attacker.example/nullsig", null),
    ];
    const res = await expandWith(sources);
    expect(res.status).toBe(200);
    expect(requested().filter((u) => u.includes("attacker.example"))).toEqual([]);
    expect(requested()).toContain(good);
    const prompt = reportPrompt();
    expect(prompt).toContain(`Source: ${SRC[1]}\nTitle: Title 1\nText: `);
    for (const i of [0, 2, 3, 4, 5, 6, 7]) expect(prompt).toContain(`Title: Title ${i}\nSnippet ${i}`);
  });

  it("a url stored as a one-element array with a valid sig fetches only the signed url (string coercion is harmless)", async () => {
    const good = "https://pub-a.example/story";
    const res = await expandWith([{ ...src(0, good), url: [good], sig: signSourceLink(good, SECRET) }]);
    expect(res.status).toBe(200);
    expect(requested().filter((u) => !u.endsWith("/robots.txt"))).toEqual([good]);
  });

  it("a signed link that redirects into a private address is not followed there", async () => {
    const meta = "http://169.254.169.254/latest/meta-data/";
    const inside = "https://inside.example/x";
    const r1 = `https://redirect.example/a?to=${encodeURIComponent(meta)}`;
    const r2 = `https://redirect.example/b?to=${encodeURIComponent(inside)}`;
    await expandWith([src(0, r1, signSourceLink(r1, SECRET)), src(1, r2, signSourceLink(r2, SECRET))]);
    expect(requested()).toContain(r1);
    expect(requested()).toContain(r2);
    const hosts = requested().map((u) => new URL(u).hostname);
    expect(hosts.filter((h) => h === "169.254.169.254" || h === "inside.example")).toEqual([]);
  });

  it("with no secret, or one under 32 characters, nothing at all is requested", async () => {
    for (const secret of ["", "x".repeat(31)]) {
      vi.stubEnv("SOURCE_LINK_SECRET", secret);
      vi.mocked(fetch).mockClear();
      const good = "https://pub-a.example/story";
      // Even a link signed under that short secret is not trusted.
      const res = await expandWith([src(0, good, secret ? signSourceLink(good, secret) : signSourceLink(good, SECRET))]);
      expect(res.status).toBe(200);
      expect(requested()).toEqual([]);
    }
  });

  it("with a short secret, writeCard stores no sig at all", async () => {
    vi.stubEnv("SOURCE_LINK_SECRET", "x".repeat(31));
    const card = await writeCard(
      { topic: TOPIC, articles: [{ title: "A", snippet: "S", url: "https://pub-a.example/story", source: SRC[0], topic: TOPIC, publishedAt: "2026-10-02T10:00:00Z" }] },
      3
    );
    expect("sig" in card.sources[0]).toBe(false);
  });

  it("a pre-change card (no sig anywhere) is written from snippets with no fetch", async () => {
    const res = await expandWith([src(0, "https://pub-a.example/story"), src(1, "https://pub-b.example/story")]);
    expect(res.status).toBe(200);
    expect(requested()).toEqual([]);
    expect(reportPrompt()).not.toContain("Full-text articles");
    expect(reportPrompt()).toContain("Title: Title 0\nSnippet 0\n\nSource: ");
  });
});
