import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { getCardsForTopicOnDate, getDigestForDate, getStoryTimelines, saveGeneratedCards } from "@/lib/digests";
import { getSavedCards } from "@/lib/bookmarks";
import type { Card } from "@/types";

// The read side of the story timeline: which cards are looked up, what one
// query asks PostgREST for, and how Day N and the earlier list are built from
// the rows that come back.

type Rows = unknown[] | { message: string };

/** A real supabase-js client whose fetch answers by path and records each URL. */
function recordingClient(answer: (url: URL) => Rows) {
  const urls: URL[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    if (init?.method === "POST") return new Response(null, { status: 204 });
    const body = answer(url);
    const failed = !Array.isArray(body);
    const single = url.pathname === "/rest/v1/digests";
    return new Response(JSON.stringify(failed ? { ...body, code: "XX000" } : single ? body[0] ?? null : body), {
      status: failed ? 500 : 200,
      headers: { "content-type": "application/json" },
    });
  });
  const client = createClient("https://example.supabase.co", "anon-key", {
    global: { fetch: fetch as unknown as typeof globalThis.fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, urls, fetch };
}

const member = (id: string, story: string, date: string, title = `T ${id}`, topic = "Geopolitics") => ({
  id,
  story_id: story,
  title,
  topic,
  digests: { date, user_id: "user-1" },
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("getStoryTimelines", () => {
  it("asks once for every story still running, scoped to the reader", async () => {
    const { client, urls } = recordingClient(() => []);
    await getStoryTimelines(client, "user-1", [
      { id: "c1", storyId: "S1", date: "2026-10-13" },
      { id: "c2", storyId: "S2", date: "2026-10-13" },
      { id: "c3", storyId: "S1", date: "2026-10-13" },
    ]);
    expect(urls).toHaveLength(1);
    expect(urls[0].pathname).toBe("/rest/v1/cards");
    expect(urls[0].searchParams.get("story_id")).toBe("in.(S1,S2)");
    expect(urls[0].searchParams.get("digests.user_id")).toBe("eq.user-1");
    expect(urls[0].searchParams.get("select")).toBe("id,story_id,title,topic,subtopic,digests!inner(date,user_id)");
  });

  it("reads nothing when every card is its story's first", async () => {
    const { client, urls } = recordingClient(() => []);
    const result = await getStoryTimelines(client, "user-1", [
      { id: "c1", storyId: "c1", date: "2026-10-13" },
      { id: "c2", storyId: null, date: "2026-10-13" },
    ]);
    expect(urls).toHaveLength(0);
    expect(result.size).toBe(0);
  });

  it("counts distinct days up to the card's own and lists one card per earlier day, oldest first", async () => {
    const { client } = recordingClient(() => [
      member("today", "S", "2026-10-13"),
      member("d12b", "S", "2026-10-12", "Second on the 12th"),
      member("d10", "S", "2026-10-10", "Talks open in Doha"),
      member("d12a", "S", "2026-10-12", "First on the 12th"),
      member("later", "S", "2026-10-15"),
    ]);
    const result = await getStoryTimelines(client, "user-1", [{ id: "today", storyId: "S", date: "2026-10-13" }]);
    expect(result.get("today")).toEqual({
      date: "2026-10-13",
      day: 3,
      earlier: [
        { id: "d10", date: "2026-10-10", title: "Talks open in Doha", topic: "Geopolitics", subtopic: null },
        { id: "d12a", date: "2026-10-12", title: "First on the 12th", topic: "Geopolitics", subtopic: null },
      ],
    });
  });

  it("carries a Countries card's country into its entry, and reads an empty subtopic as none", async () => {
    const { client } = recordingClient(() => [
      { ...member("us", "S", "2026-10-10", "Vote in Congress", "Countries"), subtopic: "United States" },
      { ...member("blank", "S", "2026-10-11", "Budget talks", "Countries"), subtopic: "" },
      member("today", "S", "2026-10-13"),
    ]);
    const result = await getStoryTimelines(client, "user-1", [{ id: "today", storyId: "S", date: "2026-10-13" }]);
    expect(result.get("today")?.earlier).toEqual([
      { id: "us", date: "2026-10-10", title: "Vote in Congress", topic: "Countries", subtopic: "United States" },
      { id: "blank", date: "2026-10-11", title: "Budget talks", topic: "Countries", subtopic: null },
    ]);
  });

  it("shows a history card the story as it stood that day, never later days", async () => {
    const { client } = recordingClient(() => [
      member("d10", "S", "2026-10-10"),
      member("d12", "S", "2026-10-12"),
      member("d15", "S", "2026-10-15"),
    ]);
    const result = await getStoryTimelines(client, "user-1", [{ id: "d12", storyId: "S", date: "2026-10-12" }]);
    expect(result.get("d12")?.day).toBe(2);
    expect(result.get("d12")?.earlier.map((e) => e.id)).toEqual(["d10"]);
  });

  it("gives no timeline when every other card of the story is on the same day or later", async () => {
    const { client } = recordingClient(() => [member("a", "S", "2026-10-13"), member("b", "S", "2026-10-13"), member("c", "S", "2026-10-14")]);
    const result = await getStoryTimelines(client, "user-1", [{ id: "b", storyId: "S", date: "2026-10-13" }]);
    expect(result.has("b")).toBe(false);
  });

  it("fails open: a failed read logs once and gives no timelines", async () => {
    const { client } = recordingClient(() => ({ message: "boom" }));
    const result = await getStoryTimelines(client, "user-1", [{ id: "c1", storyId: "S1", date: "2026-10-13" }]);
    expect(result.size).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

const cardRow = (id: string, story: string | null) => ({
  id,
  topic: "Geopolitics",
  short_summary: "s",
  expanded_report: null,
  sources: [],
  published_at: "2026-10-13T08:00:00Z",
  created_at: "2026-10-13T09:00:00Z",
  severity: 3,
  front_page_rank: null,
  title: `Card ${id}`,
  labels: [],
  subtopic: null,
  story_id: story,
});

describe("the pages' card reads", () => {
  function pageClient(cards: unknown[], timelineRows: unknown[]) {
    return recordingClient((url) => {
      if (url.pathname === "/rest/v1/digests") return [{ id: "dg", date: "2026-10-13", last_generated_at: null }];
      if (url.pathname === "/rest/v1/bookmarks") return [];
      if (url.searchParams.get("story_id")?.startsWith("in.")) return timelineRows;
      return cards;
    });
  }

  it("the front page and history days attach timelines with one extra query", async () => {
    const { client, urls } = pageClient([cardRow("new", "S"), cardRow("first", "first")], [member("old", "S", "2026-10-11"), member("new", "S", "2026-10-13")]);
    const digest = await getDigestForDate(client, "user-1", "2026-10-13");
    expect(urls.filter((u) => u.searchParams.get("story_id")?.startsWith("in."))).toHaveLength(1);
    expect(digest?.cards.find((c) => c.id === "new")?.timeline).toEqual({
      date: "2026-10-13",
      day: 2,
      earlier: [{ id: "old", date: "2026-10-11", title: "T old", topic: "Geopolitics", subtopic: null }],
    });
    expect(digest?.cards.find((c) => c.id === "first")?.timeline).toBeUndefined();
    expect(digest?.cards.map((c) => c.id)).toEqual(["new", "first"]);
  });

  it("topic pages do the same", async () => {
    const { client } = pageClient([cardRow("new", "S")], [member("old", "S", "2026-10-11")]);
    const cards = await getCardsForTopicOnDate(client, "user-1", "2026-10-13", "Geopolitics");
    expect(cards[0].timeline?.day).toBe(2);
  });

  it("a page still loads, with no chips, when the timeline read fails", async () => {
    const { client } = recordingClient((url) => {
      if (url.pathname === "/rest/v1/digests") return [{ id: "dg", date: "2026-10-13", last_generated_at: null }];
      if (url.pathname === "/rest/v1/bookmarks") return [];
      if (url.searchParams.get("story_id")?.startsWith("in.")) return { message: "boom" };
      return [cardRow("new", "S")];
    });
    const digest = await getDigestForDate(client, "user-1", "2026-10-13");
    expect(digest?.cards).toHaveLength(1);
    expect(digest?.cards[0].timeline).toBeUndefined();
  });

  it("the Saved page reads each card's timeline as of its own day", async () => {
    const { client } = recordingClient((url) => {
      if (url.pathname === "/rest/v1/bookmarks") {
        return [
          { cards: { ...cardRow("a", "S"), digests: { date: "2026-10-12" } } },
          { cards: { ...cardRow("b", "S"), digests: { date: "2026-10-14" } } },
        ];
      }
      return [member("first", "S", "2026-10-10"), member("a", "S", "2026-10-12"), member("b", "S", "2026-10-14")];
    });
    const saved = await getSavedCards(client, "user-1");
    expect(saved.map((c) => [c.id, c.date, c.timeline?.day])).toEqual([
      ["a", "2026-10-12", 2],
      ["b", "2026-10-14", 3],
    ]);
  });
});

describe("saveGeneratedCards", () => {
  const base: Card = {
    id: "c1",
    topic: "Geopolitics",
    title: "t",
    shortSummary: "s",
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-13T08:00:00Z",
    generatedAt: "2026-10-13T09:00:00Z",
    bookmarked: false,
    severity: 3,
    frontPageRank: null,
    subtopic: null,
  };

  async function sentCards(links?: Map<string, { embedding: number[] | null; storyId: string }>) {
    const rpc = vi.fn(async () => ({ error: null }));
    await saveGeneratedCards({ rpc } as never, "d1", [base, { ...base, id: "c2" }], "2026-10-13T09:00:00Z", [], [], links);
    return ((rpc.mock.calls[0] as unknown[])[1] as { p_cards: Record<string, unknown>[] }).p_cards;
  }

  it("sends each card's embedding and story", async () => {
    const cards = await sentCards(new Map([["c1", { embedding: [0.1, 0.2], storyId: "S" }]]));
    expect(cards[0]).toMatchObject({ embedding: [0.1, 0.2], storyId: "S" });
    expect(cards[1]).toMatchObject({ embedding: null, storyId: "c2" });
  });

  it("without links, sends every card as a story of its own with no embedding", async () => {
    const cards = await sentCards();
    expect(cards.map((c) => [c.embedding, c.storyId])).toEqual([
      [null, "c1"],
      [null, "c2"],
    ]);
  });
});
