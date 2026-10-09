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

  it("serves football at /topic/football", () => {
    expect(topicToSlug("Football")).toBe("football");
    expect(slugToTopic("football")).toBe("Football");
  });

  // The old football slug is answered by a redirect in next.config.ts. If it
  // ever resolved to a topic again, that redirect would hide the live page.
  it("no longer resolves the old european-football slug", () => {
    expect(slugToTopic("european-football")).toBeNull();
  });

  // Same for the retired Morocco topic, whose old links redirect to the
  // Countries page filtered to Morocco.
  it("no longer resolves the old morocco slug", () => {
    expect(slugToTopic("morocco")).toBeNull();
  });

  it("keeps the slugs old links already carry", () => {
    expect(topicToSlug("Tech/AI")).toBe("tech-ai");
    expect(topicToSlug("US Politics")).toBe("us-politics");
    expect(topicToSlug("Morocco Politics")).toBe("morocco-politics");
    expect(topicToSlug("French Politics")).toBe("french-politics");
    expect(topicToSlug("Geopolitics")).toBe("geopolitics");
    expect(topicToSlug("Morocco Finance")).toBe("morocco-finance");
    expect(topicToSlug("US Finance")).toBe("us-finance");
    expect(topicToSlug("World Finance")).toBe("world-finance");
    expect(topicToSlug("Basketball")).toBe("basketball");
    expect(topicToSlug("Tennis")).toBe("tennis");
    expect(topicToSlug("American Football")).toBe("american-football");
  });
});
