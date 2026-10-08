import { act } from "react";
import { MAX_READING_UNITS } from "@/lib/readingUnits";

/** Every topic chip in the grid, in page order. */
export const chips = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="topic-chip"]')];

/** A chip's accessible name: its topic name (the description is its description). */
export const chipName = (chip: HTMLElement) => document.getElementById(chip.getAttribute("aria-labelledby")!)!.textContent;

export const chipNames = () => chips().map(chipName);

export const chip = (topic: string) => chips().find((c) => chipName(c) === topic);

export const isPicked = (topic: string) => chip(topic)?.getAttribute("aria-pressed") === "true";

export async function clickChip(topic: string) {
  const target = chip(topic);
  if (target === undefined) throw new Error(`no chip for ${topic}`);
  await act(async () => target.click());
}

/** The topic grid's search box. */
export const topicSearch = () => document.getElementById("preferences-topics-search") as HTMLInputElement;

export async function searchTopics(text: string) {
  const input = topicSearch();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The shared counter's text at the limit. */
export const AT_LIMIT = `${MAX_READING_UNITS} of ${MAX_READING_UNITS} · limit reached, remove one to add another`;
