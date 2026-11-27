/** A short lesson from each plan's first decisive outcome, read by the next analysis of that stock. */
import { aiLine } from "./briefs";
import type { Env } from "./env";
import type { Plan } from "./plans";
import type { Outcome, Store } from "./store";

const SYSTEM = "You review a past stock plan and its outcome. In at most 2 sentences, write the lesson for the next " +
  "analysis of this stock: what the plan got right or wrong and what to do differently. Use only the facts given.";

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

/** The decision section of the stock's saved report, if any. */
async function decision(store: Store, code: string): Promise<string> {
  const text = (await store.loadReport(code))?.text ?? "";
  const at = text.indexOf("## Decision");
  return at >= 0 ? text.slice(at + "## Decision".length).trim().slice(0, 800) : "n/a";
}

/**
 * Write the plan's lesson once its first decisive outcome is known (a level hit, or the 12-week return), once per
 * plan. Returns the lesson, or null when none was written (not decisive yet, already written, or no AI budget).
 */
export async function learn(env: Env, store: Store, outcome: Outcome, plan: Plan, now: Date): Promise<string | null> {
  if (!outcome.firstHit && outcome.ret12w === null) return null;
  if (await store.hasLesson(plan.id)) return null;
  const hit = outcome.firstHit === "SL" ? "the stop-loss was hit first" : outcome.firstHit === "TP" ? "the take-profit was hit first"
    : "neither level was hit";
  const facts = [
    `Plan for ${plan.code} made ${plan.createdAt.slice(0, 10)}: ${plan.action}, confidence ${plan.confidence}, ` +
      `entry ${plan.entryLow ?? "n/a"}-${plan.entryHigh ?? "n/a"}, take-profit ${plan.tp ?? "n/a"}, stop-loss ${plan.sl ?? "n/a"}.`,
    `Reasoning: ${plan.reasoning}`,
    `Outcome: ${hit}; return after 4 weeks ${pct(outcome.ret4w)}, 12 weeks ${pct(outcome.ret12w)}, 26 weeks ${pct(outcome.ret26w)}.`,
    `The analysis decision: ${await decision(store, plan.code)}`,
  ].join("\n");
  const lesson = await aiLine(env, store, SYSTEM, facts, 120, now);
  if (!lesson) return null;
  await store.saveLesson(plan.code, plan.id, lesson, now);
  return lesson;
}

export async function recentLessons(store: Store, code: string, n = 3): Promise<string[]> {
  return store.recentLessons(code, n);
}
