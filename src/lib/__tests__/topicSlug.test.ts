import { describe, it, expect } from "vitest";
import { TOPICS } from "@/types";
import { topicToSlug, slugToTopic } from "@/lib/topicSlug";

describe("topicToSlug / slugToTopic", () => {
  it("round-trips every topic in TOPICS", () => {
    for (const topic of TOPICS) {
      const slug = topicToSlug(topic);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slugToTopic(slug)).toBe(topic);
    }
  });

  it("produces a unique slug per topic (no collisions)", () => {
    const slugs = TOPICS.map(topicToSlug);
    expect(new Set(slugs).size).toBe(TOPICS.length);
  });

  it("returns null for an unrecognized slug", () => {
    expect(slugToTopic("not-a-real-topic")).toBeNull();
    expect(slugToTopic("")).toBeNull();
  });
});
