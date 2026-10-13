import { describe, expect, it, vi } from "vitest";

// next/font/google only works inside a Next build; the layout calls it at import.
vi.mock("next/font/google", () => ({
  Newsreader: () => ({ variable: "font-newsreader" }),
  Source_Serif_4: () => ({ variable: "font-source-serif-4" }),
}));

const { metadata } = await import("@/app/layout");
const { PRODUCT_NAME } = await import("@/config/brand");

describe("root metadata", () => {
  it("uses the product's name as the browser tab title", () => {
    expect(metadata.title).toBe(PRODUCT_NAME);
  });
});
