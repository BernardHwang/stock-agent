/** Fold a fresh analysis into a stock's plan. Ported from the Python app (src/stockagent/lifecycle.py at 9c81be3). */
import type { Plan, PlanFields } from "./plans";
import type { Store } from "./store";

const exitLevels = (f: PlanFields) => [f.partialTp, f.tp, f.sl].join("|");

/**
 * ``held`` means the owner owns the stock. Returns the saved plan, or null when nothing was saved (an action other
 * than BUY for a stock that isn't held).
 */
export async function applyNewAnalysis(store: Store, code: string, fields: PlanFields, held: boolean, now: Date):
  Promise<Plan | null> {
  const active = await store.planFor(code);
  // Already owned: "buy" means keep holding with these levels.
  const owned = (f: PlanFields): PlanFields => (f.action === "BUY" ? { ...f, action: "HOLD" } : f);

  if (active?.state === "HELD") {
    const next = owned(fields);
    const updated: Plan = { ...active, ...next, fired: exitLevels(next) === exitLevels(active) ? active.fired : [] };
    await store.updatePlan(updated);
    return updated;
  }
  if (active) await store.updatePlan({ ...active, state: "EXPIRED" });

  if (held) {
    const next = owned(fields);
    const id = await store.savePlan(code, next, "HELD", now);
    return { ...next, id, code, state: "HELD", createdAt: now.toISOString(), fired: [] };
  }
  if (fields.action !== "BUY") return null;
  const id = await store.savePlan(code, fields, "OPEN", now);
  return { ...fields, id, code, state: "OPEN", createdAt: now.toISOString(), fired: [] };
}
