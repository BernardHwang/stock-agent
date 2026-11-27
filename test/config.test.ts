import { describe, expect, it } from "vitest";
import { SCREENER, UNIVERSE } from "../src/config";

describe("config", () => {
  it("has the US universe, deduplicated", () => {
    expect(UNIVERSE).toContain("US.NVDA");
    expect(UNIVERSE.every((c) => c.startsWith("US."))).toBe(true);
    expect(new Set(UNIVERSE).size).toBe(UNIVERSE.length);
  });

  it("has the screener thresholds", () =>
    expect(SCREENER).toEqual({ maxForwardPe: 60, minRevenueGrowth: 0.1, minEarningsGrowth: 0.1, pullbackMin: 0.1, pullbackMax: 0.25 }));
});
