/** Reconcile plans with what the owner holds in moomoo. Ported from the Python app (src/stockagent/holdings.py at 9c81be3). */
import type { Env } from "./env";
import { positions } from "./moomoo/api";
import { accessToken } from "./moomoo/oauth";
import type { Plan } from "./plans";
import type { Position, Store } from "./store";

const NEW_HOLDING_PRIORITY = 1; // ahead of weekly reviews, behind what you ask for in chat
const EMPTY_READ_KEY = "positions_empty_read";
const COST_MATCH_TOLERANCE = 0.15; // a position bought further from the plan's buy zone wasn't bought on that plan

function boughtElsewhere(plan: Plan, avgCost: number | null): boolean {
  if (avgCost === null || plan.state === "TRIGGERED" || plan.action !== "BUY") return false;
  if (plan.entryLow === null || plan.entryHigh === null) return false;
  return !(plan.entryLow * (1 - COST_MATCH_TOLERANCE) <= avgCost && avgCost <= plan.entryHigh * (1 + COST_MATCH_TOLERANCE));
}

/**
 * Read positions from moomoo and reconcile. Null when moomoo isn't connected. Throws MoomooUnavailable or a network
 * error when moomoo fails; nothing changes then.
 */
export async function syncFromMoomoo(env: Env, store: Store, now: Date): Promise<{ messages: string[]; count: number } | null> {
  const token = await accessToken(env, store, now);
  if (!token) return null;
  const { positions: current } = await positions(token);
  const messages = await syncHoldings(store, current, now);
  await store.setSetting("last_sync", now.toISOString());
  return { messages, count: current.length };
}

/** Returns the messages for the owner. */
export async function syncHoldings(store: Store, current: Position[], now: Date): Promise<string[]> {
  const previous = new Set((await store.lastPositions()).map((p) => p.code));
  const held = new Map(current.map((p) => [p.code, p]));
  const messages: string[] = [];

  // moomoo can briefly report no positions; trust "everything sold" only on a second read.
  if (!held.size && previous.size && !(await store.getSetting(EMPTY_READ_KEY))) {
    await store.setSetting(EMPTY_READ_KEY, "1");
    return messages;
  }
  await store.setSetting(EMPTY_READ_KEY, "");

  const retired = new Set<string>();
  for (const plan of await store.activePlans()) {
    const position = held.get(plan.code);
    if (plan.state !== "TRIGGERED" && position && boughtElsewhere(plan, position.avgCost)) {
      await store.updatePlan({ ...plan, state: "CLOSED" });
      retired.add(plan.code);
      await store.enqueue(plan.code, "new_holding", NEW_HOLDING_PRIORITY, now);
      messages.push(`Your ${plan.code} cost (${position.avgCost!.toFixed(2)}) is far from plan #${plan.id}'s buy zone, ` +
        "so I've retired that plan and queued a fresh analysis.");
    }
  }

  const active = await store.activePlans();
  for (const code of [...held.keys()].filter((c) => !previous.has(c)).sort()) {
    const plan = active.find((p) => p.code === code);
    if (plan && (plan.state === "OPEN" || plan.state === "TRIGGERED")) {
      await store.updatePlan({ ...plan, state: "HELD", action: "HOLD" }); // owned now
      messages.push(`I see you picked up ${code} in moomoo. I've linked it to plan #${plan.id} and I'm watching its ` +
        "stop-loss.");
    } else if (!plan && !retired.has(code)) {
      await store.enqueue(code, "new_holding", NEW_HOLDING_PRIORITY, now);
      messages.push(`Now tracking your position in ${code}. I've queued an analysis to set its target and stop-loss.`);
    }
  }

  for (const plan of active.filter((p) => p.state === "HELD" && !held.has(p.code))) {
    await store.updatePlan({ ...plan, state: "CLOSED" });
    messages.push(`Looks like you closed out ${plan.code}, so I've wrapped up plan #${plan.id}.`);
  }

  await store.savePositions(current, now);
  return messages;
}
