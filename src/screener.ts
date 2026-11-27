/**
 * The weekly two-stage screen, without AI: one snapshot of the universe for valuation and trend, then income
 * statements for the strongest movers. Holdings are excluded.
 */
import { SCREENER, UNIVERSE } from "./config";
import { snapshotFacts } from "./market";
import { snapshotRows } from "./moomoo/api";
import { incomeGrowth } from "./moomoo/research";

const STATEMENTS_MAX = 15; // stage 2 calls, so the whole screen stays within ~20 requests
const IDEAS = 3;

export interface Idea {
  code: string;
  name: string;
  price: number;
  revenueGrowth: number; // year-on-year, percent
  earningsGrowth: number;
  reason: "pullback" | "uptrend";
}

export async function screen(token: string, exclude: Set<string>): Promise<Idea[]> {
  const codes = UNIVERSE.filter((c) => !exclude.has(c));
  const facts = snapshotFacts(await snapshotRows(token, codes));

  const candidates: { code: string; name: string; price: number; reason: Idea["reason"]; momentum: number }[] = [];
  for (const f of facts.values()) {
    if (exclude.has(f.code) || f.last === null || f.pe === null || f.pe <= 0 || f.pe > SCREENER.maxForwardPe) continue;
    const drop = f.high52 ? 1 - f.last / f.high52 : null;
    const pullback = drop !== null && drop >= SCREENER.pullbackMin && drop <= SCREENER.pullbackMax;
    const uptrend = f.close60 !== null && f.close250 !== null && f.last > f.close60 && f.close60 > f.close250;
    if (!pullback && !uptrend) continue;
    candidates.push({ code: f.code, name: f.name, price: f.last, reason: pullback ? "pullback" : "uptrend",
      momentum: f.close60 ? f.last / f.close60 : 0 });
  }
  candidates.sort((a, b) => b.momentum - a.momentum);

  const checked = await Promise.all(candidates.slice(0, STATEMENTS_MAX).map(async (c) => {
    try {
      const g = await incomeGrowth(token, c.code);
      if (g.revenue === null || g.netIncome === null) return null;
      if (g.revenue / 100 < SCREENER.minRevenueGrowth || g.netIncome / 100 < SCREENER.minEarningsGrowth) return null;
      return { code: c.code, name: c.name, price: c.price, reason: c.reason, revenueGrowth: g.revenue, earningsGrowth: g.netIncome };
    } catch (e) {
      console.error("screener statement failed", e instanceof Error ? e.name : typeof e);
      return null;
    }
  }));
  return checked.filter((i): i is Idea => i !== null)
    .sort((a, b) => b.revenueGrowth + b.earningsGrowth - (a.revenueGrowth + a.earningsGrowth))
    .slice(0, IDEAS);
}
