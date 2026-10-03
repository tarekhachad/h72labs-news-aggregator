import { describe, it, expect, vi } from "vitest";
import type { Article } from "@/types";

// Deterministic embeddings: the marker in a title picks the vector.
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) =>
      texts.map((t) => (t.includes("STORY_A") ? [1, 0] : t.includes("STORY_B") ? [0, 1] : [Math.SQRT1_2, Math.SQRT1_2]))
    ),
  };
});

import { clusterArticles } from "@/lib/cluster";

function article(overrides: Partial<Article>): Article {
  return {
    title: "STORY_A",
    snippet: "s",
    url: `https://x.test/${Math.random()}`,
    source: "BBC",
    topic: "Africa",
    publishedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("cluster subtopic tagging", () => {
  it("a cluster led by an article with subtopic null has no subtopic key", async () => {
    const [c] = await clusterArticles([article({ subtopic: null })]);
    expect(Object.keys(c)).not.toContain("subtopic");
  });

  it("a cluster led by an article with subtopic '' has no subtopic key", async () => {
    const [c] = await clusterArticles([article({ subtopic: "" })]);
    expect(Object.keys(c)).not.toContain("subtopic");
  });

  it("two countries' separate stories stay two clusters, each with its own country", async () => {
    const clusters = await clusterArticles([
      article({ title: "STORY_A", topic: "Countries", subtopic: "Kenya" }),
      article({ title: "STORY_B", topic: "Countries", subtopic: "Ghana" }),
    ]);
    expect(clusters.map((c) => [c.topic, c.subtopic])).toEqual([
      ["Countries", "Kenya"],
      ["Countries", "Ghana"],
    ]);
  });

  it("a cluster led by one country and joined by another keeps the first country", async () => {
    const [c, ...rest] = await clusterArticles([
      article({ title: "STORY_A", topic: "Countries", subtopic: "Kenya" }),
      article({ title: "STORY_A again", topic: "Countries", subtopic: "Uganda" }),
    ]);
    expect(rest).toEqual([]);
    expect(c.subtopic).toBe("Kenya");
    expect(c.articles.map((a) => a.subtopic)).toEqual(["Kenya", "Uganda"]);
  });

  it("topic and subtopic never come from different articles", async () => {
    const [c] = await clusterArticles([
      article({ title: "STORY_A", topic: "Africa" }),
      article({ title: "STORY_A 2", topic: "Countries", subtopic: "Kenya" }),
      article({ title: "STORY_A 3", topic: "Countries", subtopic: "Ghana" }),
    ]);
    expect(c.topic).toBe("Africa");
    expect(c).not.toHaveProperty("subtopic");
  });

  it("a cluster led by a Countries article with no subtopic is Countries with no subtopic", async () => {
    const [c] = await clusterArticles([article({ topic: "Countries" })]);
    expect(c.topic).toBe("Countries");
    expect(c).not.toHaveProperty("subtopic");
  });
});
