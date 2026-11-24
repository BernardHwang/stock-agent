/** Turn the portfolio manager's answer into checked plan fields, with one corrective retry. */
import { type PlanAction, type PlanFields, validateAgainstPrice, validateFields } from "./plans";

export const REASONING_MAX = 600;
export const RETRY_NOTE = "Your previous plan was rejected";

const ACTIONS: PlanAction[] = ["BUY", "HOLD", "TRIM", "EXIT"];
const CONFIDENCE = ["low", "medium", "high"] as const;

function level(v: unknown, name: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} is not a number`);
  return n;
}

/** The first {...} block in the text (also inside code fences), as plan fields. Throws when there is none. */
export function parsePlan(text: string): PlanFields {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("the answer contained no JSON plan");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    throw new Error("the answer's JSON could not be read");
  }
  const action = String(raw.action ?? "").toUpperCase() as PlanAction;
  if (!ACTIONS.includes(action)) throw new Error(`unknown action ${String(raw.action)}`);
  const confidence = String(raw.confidence ?? "").toLowerCase() as PlanFields["confidence"];
  if (!CONFIDENCE.includes(confidence)) throw new Error(`unknown confidence ${String(raw.confidence)}`);
  const months = Number(raw.holding_months ?? 0);
  let reasoning = String(raw.reasoning ?? "").trim();
  if (reasoning.length > REASONING_MAX) reasoning = `${reasoning.slice(0, REASONING_MAX - 1)}…`;
  return {
    action,
    entryLow: level(raw.entry_low, "entry_low"),
    entryHigh: level(raw.entry_high, "entry_high"),
    partialTp: level(raw.partial_tp, "partial_tp"),
    tp: level(raw.tp, "tp"),
    sl: level(raw.sl, "sl"),
    confidence,
    holdingMonths: Number.isFinite(months) ? Math.max(0, Math.round(months)) : 0,
    reasoning,
  };
}

function check(text: string, price: number): { fields: PlanFields } | { errors: string[] } {
  try {
    const fields = parsePlan(text);
    const errors = validateFields(fields);
    const priceErrors = errors.length ? [] : validateAgainstPrice(fields, price);
    return errors.length || priceErrors.length ? { errors: [...errors, ...priceErrors] } : { fields };
  } catch (e) {
    return { errors: [e instanceof Error ? e.message : String(e)] };
  }
}

/**
 * Ask the portfolio manager (``askPm("")``), check the plan, and on failure ask once more with the reasons.
 * ``askPm`` receives extra text to append to its prompt.
 */
export async function extractPlan(askPm: (extra: string) => Promise<string>, price: number):
  Promise<{ fields: PlanFields } | { errors: string[] }> {
  const first = check(await askPm(""), price);
  if ("fields" in first) return first;
  const note = `${RETRY_NOTE}: ${first.errors.join("; ")}. Return a corrected plan as the JSON object only; ` +
    "for HOLD or TRIM give both tp and sl.";
  return check(await askPm(note), price);
}
