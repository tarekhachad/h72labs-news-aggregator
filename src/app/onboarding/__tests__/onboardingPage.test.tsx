// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS } from "@/types";

// /onboarding as the page builds it: a refused save keeps the picks the
// reader made and shows a fixed message. The page reads no query string, so
// an old or crafted ?error= link has nothing to show.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ saveProfile: vi.fn() }));
vi.mock("@/app/onboarding/actions", () => ({ saveProfile: mocks.saveProfile }));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { PROFILE_ERROR_MESSAGES } = await import("@/lib/profileErrors");
const { default: OnboardingPage } = await import("@/app/onboarding/page");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.saveProfile.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function key(target: Element, k: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

async function pickWithClick(inputId: string, label: string) {
  const input = document.getElementById(inputId) as HTMLInputElement;
  await act(async () => input.focus());
  await key(input, "ArrowDown");
  await flush();
  const option = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === label
  )!;
  await act(async () => option.click());
  await flush();
  await key(input, "Escape");
}

const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

describe("/onboarding", () => {
  it("keeps the picks made on the page after a refused save, with the code's message", async () => {
    mocks.saveProfile.mockResolvedValue({ error: "too_few" });
    await act(async () => root.render(OnboardingPage() as ReactElement));
    expect(container.querySelector('[role="alert"]')).toBeNull();

    const topic = TOPICS.filter((t) => t !== COUNTRIES_TOPIC)[0];
    await pickWithClick("preferences-topics", topic);
    await pickWithClick("preferences-countries", "Morocco");

    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();

    expect(mocks.saveProfile).toHaveBeenCalledTimes(1);
    expect(fieldValues("topics")).toEqual([topic]);
    expect(fieldValues("countries")).toEqual(["Morocco"]);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(PROFILE_ERROR_MESSAGES.too_few);
  });

  it("shows nothing from an old or crafted ?error= link", async () => {
    const render = OnboardingPage as unknown as (props: unknown) => ReactElement;
    const searchParams = Promise.resolve({ error: "Your account is locked. Call 555-0100" });
    await act(async () => root.render(render({ searchParams })));
    expect(container.textContent).not.toContain("555-0100");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
