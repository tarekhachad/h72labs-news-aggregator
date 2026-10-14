import { describe, expect, it } from "vitest";
import { formatDay, formatFxRate, formatOilPrice, formatYield } from "../format";

describe("rates strip formatting", () => {
  it.each([
    [5.21, "5.21%"],
    [4.2, "4.20%"],
    [0.004, "0.00%"],
    [-0.004, "0.00%"],
    [-0.25, "−0.25%"],
  ])("yield %d reads %s", (n, text) => {
    expect(formatYield(n)).toBe(text);
  });

  it.each([
    [1.1199, "1.1199"],
    [9.7515, "9.7515"],
    [1.1, "1.1000"],
    [1.123456, "1.1235"],
    [1234.5, "1,234.5000"],
  ])("rate %d reads %s", (n, text) => {
    expect(formatFxRate(n)).toBe(text);
  });

  it.each([
    [96.24, "$96.24"],
    [125.5, "$125.50"],
    [-36.98, "−$36.98"],
    [-0.001, "$0.00"],
  ])("oil price %d reads %s", (n, text) => {
    expect(formatOilPrice(n)).toBe(text);
  });

  it.each([
    ["2026-10-06", "Oct 6, 2026"],
    ["2026-12-31", "Dec 31, 2026"],
    ["2026-02-30", null],
    ["2026-10-6", null],
    ["", null],
  ])("day %j reads %j", (day, text) => {
    expect(formatDay(day)).toBe(text);
  });
});
