// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditionStrip } from "@/components/newspaper/EditionStrip";

// The ticker only shows while a run is in flight; these tests are about the
// idle strip around the button.
vi.mock("@/components/newspaper/WireTicker", () => ({
  WireTicker: () => <div data-testid="wire-ticker" />,
}));

let container: HTMLDivElement;
let root: Root;

async function render(props: { loading?: boolean; onStart: () => void }) {
  await act(async () => {
    root.render(
      <EditionStrip
        summary="3 stories · updated 07:12"
        loading={props.loading ?? false}
        onStart={props.onStart}
        stageEvent={null}
        titles={[]}
        topicNames={[]}
        reducedMotion={false}
      />
    );
  });
}

function strip() {
  return container.querySelector<HTMLElement>('[data-testid="edition-strip"]')!;
}

function button() {
  return container.querySelector<HTMLButtonElement>("button")!;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("EditionStrip: only the button reacts", () => {
  it("starts a run from the button", async () => {
    const onStart = vi.fn();
    await render({ onStart });
    await act(async () => button().click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the summary text or the strip itself is clicked", async () => {
    const onStart = vi.fn();
    await render({ onStart });
    const summary = [...strip().querySelectorAll("span")].find((s) => s.textContent?.includes("3 stories"))!;
    await act(async () => summary.click());
    await act(async () => strip().click());
    expect(onStart).not.toHaveBeenCalled();
  });

  it("has no strip-wide hover and no hit area stretched past the button", async () => {
    await render({ onStart: vi.fn() });
    expect(strip().className).not.toMatch(/(^|\s)(group|hover:\S+|cursor-pointer)(\s|$)/);
    expect(button().className).not.toContain("after:");
    expect(button().className).not.toContain("group-hover:");
    expect(button().className).toContain("enabled:hover:bg-[var(--color-foreground)]");
    expect(button().className).toContain("cursor-pointer");
  });

  it("keeps the button mounted but disabled while a run is in flight", async () => {
    const onStart = vi.fn();
    await render({ onStart, loading: true });
    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(onStart).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="wire-ticker"]')).not.toBeNull();
  });
});
