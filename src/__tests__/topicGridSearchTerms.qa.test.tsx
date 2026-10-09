// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Topic } from "@/types";
import { TopicGrid } from "@/components/onboarding/TopicGrid";
import { chipNames, searchTopics } from "@/components/__tests__/topicGridKit";

// The real topic grid search, end to end: words cut from the one-line chip
// descriptions must still find their topic through TOPIC_SEARCH_TERMS.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [value, setValue] = useState<Topic[]>([]);
  return (
    <TopicGrid
      id="preferences-topics"
      name="topics"
      value={value}
      onChange={setValue}
      countOf={(picked) => picked.length}
      min={3}
      max={20}
      noun="topics"
    />
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const CUT_WORDS: [string, string[]][] = [
  ["climate change", ["Climate & Environment"]],
  ["electric", ["Energy Transition & Renewables"]],
  ["washington", ["US Politics"]],
  ["parliament", ["Morocco Politics", "French Politics", "UK Politics"]],
  ["casablanca", ["Morocco Finance"]],
  ["hollywood", ["Film & TV"]],
  ["mortgage", ["Personal Finance", "Real Estate"]],
  ["earthquake", ["Weather & Natural Disasters"]],
  ["wildfire", ["Weather & Natural Disasters"]],
  ["video games", ["Gaming"]],
  ["hospital", ["Health & Medicine"]],
  ["southeast asia", ["Asia-Pacific"]],
  ["south africa", ["Africa"]],
  ["interest rates", ["Economy"]],
  ["grand prix", ["Formula 1"]],
  ["transfers", ["Football"]],
  ["clinical trials", ["Biotech & Pharma"]],
  ["defence", ["Defense & Security"]],
];

describe("topic grid search with TOPIC_SEARCH_TERMS", () => {
  it.each(CUT_WORDS)("'%s' finds %j", async (query, expected) => {
    await searchTopics(query);
    expect(chipNames()).toEqual(expect.arrayContaining(expected));
  });

  it("'morocco' finds Morocco Politics and Morocco Finance only", async () => {
    await searchTopics("morocco");
    expect(chipNames()).toEqual(["Morocco Politics", "Morocco Finance"]);
  });
});
