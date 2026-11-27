/** Scores every plan after the fact. Ported from src/stockagent/outcomes.py at 9c81be3. */
import type { Env } from "./env";
import { accessToken } from "./moomoo/oauth";
import { addDays, type Candle, candles } from "./moomoo/research";
import type { Plan } from "./plans";
import type { Outcome, Store } from "./store";
import { localParts } from "./time";

const WEEKS = [4, 12, 26] as const;
const PLANS_PER_RUN = 15; // one candle call each, within the cron's 50-request budget

function firstHit(plan: Plan, cs: Candle[]): "SL" | "TP" | null {
  for (const c of cs) {
    if (plan.sl !== null && c.low <= plan.sl) return "SL"; // a same-day touch of both counts as the stop: the conservative reading
    if (plan.tp !== null && c.high >= plan.tp) return "TP";
  }
  return null;
}

/**
 * The first level hit and the return at 4, 12 and 26 weeks (fractions) from the entry midpoint, or else the first
 * close. A week still in the future, or past the last candle, gives null.
 */
export function scorePlan(plan: Plan, all: Candle[], today: string): { firstHit: "SL" | "TP" | null; returns: (number | null)[] } {
  const start = plan.createdAt.slice(0, 10);
  const cs = all.filter((c) => c.date >= start && c.date <= today);
  const ref = plan.entryLow && plan.entryHigh ? (plan.entryLow + plan.entryHigh) / 2 : cs[0]?.close;
  const returns = WEEKS.map((w) => {
    const target = addDays(start, w * 7);
    const later = cs.find((c) => c.date >= target);
    return ref && target <= today && later ? later.close / ref - 1 : null;
  });
  return { firstHit: firstHit(plan, cs), returns };
}

/** Score plans with a target and stop that are at least 4 weeks old and not fully scored; returns the outcomes that changed. */
export async function updateOutcomes(env: Env, store: Store, now: Date): Promise<Outcome[]> {
  const today = localParts(now, "America/New_York").date;
  const due: Plan[] = [];
  for (const plan of await store.allPlans()) {
    if (plan.tp === null || plan.sl === null || addDays(plan.createdAt.slice(0, 10), 28) > today) continue;
    const existing = await store.outcome(plan.id);
    if (existing?.ret26w != null) continue;
    due.push(plan);
  }
  if (!due.length) return [];
  const token = await accessToken(env, store, now);
  if (!token) return [];
  const changed: Outcome[] = [];
  for (const plan of due.slice(0, PLANS_PER_RUN)) {
    let cs: Candle[];
    try {
      cs = await candles(token, plan.code, today);
    } catch (e) {
      console.error("outcome candles failed", e instanceof Error ? e.name : typeof e);
      continue;
    }
    if (!cs.length) continue;
    const scored = scorePlan(plan, cs, today);
    const existing = await store.outcome(plan.id);
    const next: Outcome = {
      planId: plan.id, firstHit: existing?.firstHit ?? scored.firstHit,
      ret4w: scored.returns[0] ?? null, ret12w: scored.returns[1] ?? null, ret26w: scored.returns[2] ?? null,
    };
    if (JSON.stringify(existing) === JSON.stringify(next)) continue;
    await store.saveOutcome(next, now);
    changed.push(next);
  }
  return changed;
}
