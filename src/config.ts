/** Screener inputs from config/*.json. */
import screener from "../config/screener.json";
import universe from "../config/universe.json";

export const UNIVERSE: string[] = [...new Set(universe.US.filter((c) => c.startsWith("US.")))];

export const SCREENER = {
  maxForwardPe: screener.maxForwardPe,
  minRevenueGrowth: screener.minRevenueGrowth,
  minEarningsGrowth: screener.minEarningsGrowth,
  pullbackMin: screener.pullbackMin,
  pullbackMax: screener.pullbackMax,
};
