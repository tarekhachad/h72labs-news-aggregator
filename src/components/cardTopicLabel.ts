import type { Card } from "@/types";

/** What a card shows as its topic: "Countries · Uganda" for a card with a subtopic, the topic otherwise. */
export function cardTopicLabel(card: Pick<Card, "topic" | "subtopic">): string {
  return card.subtopic ? `${card.topic} · ${card.subtopic}` : card.topic;
}
