// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Card, Topic } from "@/types";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { FocusOverlay } from "@/components/newspaper/FocusOverlay";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";
import { CardItem } from "@/components/CardItem";
import { cardTopicLabel } from "@/components/cardTopicLabel";

// Wherever a card shows its topic, a Countries card shows its country too.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom has no ResizeObserver; NewsCard's line clamp needs one to exist.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function card(topic: string, subtopic?: string | null): Card {
  return {
    id: "card-1",
    topic: topic as Topic,
    ...(subtopic === undefined ? {} : { subtopic }),
    title: "A headline",
    shortSummary: "A short summary of the story.",
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: false,
    severity: 3,
    frontPageRank: 1,
  };
}

const CASES = [
  { name: "a Countries card", card: card("Countries", "Uganda"), label: "Countries · Uganda" },
  { name: "a card with a null subtopic", card: card("Tech/AI", null), label: "Tech/AI" },
  { name: "a card with no subtopic field", card: card("Tech/AI"), label: "Tech/AI" },
];

describe("cardTopicLabel", () => {
  it.each(CASES)("labels $name as $label", ({ card, label }) => {
    expect(cardTopicLabel(card)).toBe(label);
  });

  it("treats an empty subtopic as none", () => {
    expect(cardTopicLabel(card("Countries", ""))).toBe("Countries");
  });
});

describe.each(CASES)("$name", ({ card, label }) => {
  const badges = () => [...container.querySelectorAll("span")].map((s) => s.textContent);

  it("shows its label on the newspaper card", async () => {
    await act(async () =>
      root.render(
        <FocusModeProvider>
          <NewsCard card={card} tier="medium" showTopicBadge />
        </FocusModeProvider>
      )
    );
    expect(badges()).toContain(label);
  });

  it("shows its label in the focus overlay", async () => {
    await act(async () =>
      root.render(
        <FocusOverlay
          card={card}
          layoutId="card-1"
          onClose={() => {}}
          report={null}
          loadingReport={false}
          reportError={null}
          onGenerateReport={() => {}}
        />
      )
    );
    expect([...document.querySelectorAll('[role="dialog"] span')].map((s) => s.textContent)).toContain(label);
  });

  it("shows its label on a saved card", async () => {
    await act(async () => root.render(<CardItem card={card} />));
    expect(badges()).toContain(label);
  });
});
