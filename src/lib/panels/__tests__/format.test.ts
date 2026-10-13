import { describe, expect, it } from "vitest";
import { formatPercent, formatPopulation, formatUsd } from "../format";

const in2024 = (value: number) => ({ value, year: 2024 });

describe("panel number formatting", () => {
  it.each([
    [55_312_000, "55.3 million (2024)"],
    [1_438_069_596, "1.4 billion (2024)"],
    [999_960_000, "1.0 billion (2024)"],
    [999_940_000, "999.9 million (2024)"],
    [1_000_000, "1.0 million (2024)"],
    [393_396, "393,000 (2024)"],
    [5_604, "6,000 (2024)"],
  ])("population %d reads %j", (value, text) => {
    expect(formatPopulation(in2024(value))).toBe(text);
  });

  it.each([
    [108_040_000_000, "$108.0 bn (2024)"],
    [27_360_935_000_000, "$27.4 tn (2024)"],
    [999_980_000_000, "$1.0 tn (2024)"],
    [1_000_000_000, "$1.0 bn (2024)"],
    [850_000_000, "$850.0 m (2024)"],
  ])("GDP %d reads %j", (value, text) => {
    expect(formatUsd(in2024(value))).toBe(text);
  });

  it.each([
    [4.4876, "4.5% (2024)"],
    [0.93, "0.9% (2024)"],
    [-0.3, "−0.3% (2024)"],
    [-0.04, "0.0% (2024)"],
    [0, "0.0% (2024)"],
    [229.8, "229.8% (2024)"],
    [1234.5, "1,234.5% (2024)"],
  ])("inflation %d reads %j", (value, text) => {
    expect(formatPercent(in2024(value))).toBe(text);
  });
});
