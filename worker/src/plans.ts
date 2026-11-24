/** Plan types and validation, ported unchanged from src/stockagent/models.py. */

export type PlanAction = "BUY" | "HOLD" | "TRIM" | "EXIT";
export type PlanState = "OPEN" | "TRIGGERED" | "HELD" | "EXPIRED" | "CLOSED";

export interface PlanFields {
  action: PlanAction;
  entryLow: number | null;
  entryHigh: number | null;
  partialTp: number | null;
  tp: number | null;
  sl: number | null;
  confidence: "low" | "medium" | "high";
  holdingMonths: number;
  reasoning: string;
}

export interface Plan extends PlanFields {
  id: number;
  code: string;
  state: PlanState;
  createdAt: string;
  fired: string[];
}

export const BUY_ZONE_MAX_ABOVE = 0.1; // a buy zone starting further above the live price is a stale or invented level
export const BUY_ZONE_MAX_BELOW = 0.25; // one ending further below would likely never fill before the plan expires

const PRICE_FIELDS: [keyof PlanFields, string][] = [
  ["entryLow", "entry_low"], ["entryHigh", "entry_high"], ["partialTp", "partial_tp"], ["tp", "tp"], ["sl", "sl"],
];

export function validateFields(f: PlanFields): string[] {
  const errors: string[] = [];
  for (const [key, name] of PRICE_FIELDS) {
    const v = f[key];
    if (typeof v === "number" && v <= 0) errors.push(`${name} must be positive`);
  }
  if (errors.length) return errors;

  if (f.action === "BUY") {
    const { entryLow, entryHigh, tp, sl } = f;
    if (entryLow === null || entryHigh === null || tp === null || sl === null) {
      return ["BUY needs entry_low, entry_high, tp and sl"];
    }
    if (!(sl < entryLow)) errors.push("sl must be below the entry zone");
    if (!(entryLow <= entryHigh)) errors.push("entry_low must not exceed entry_high");
    if (!(entryHigh < tp)) errors.push("tp must be above the entry zone");
    if (f.partialTp !== null && !(entryHigh < f.partialTp && f.partialTp < tp)) {
      errors.push("partial_tp must be between the entry zone and tp");
    }
  } else if (f.action === "HOLD" || f.action === "TRIM") {
    const { tp, sl } = f;
    if (tp === null || sl === null) return [`${f.action} needs tp and sl`];
    if (!(sl < tp)) errors.push("sl must be below tp");
    if (f.partialTp !== null && !(sl < f.partialTp && f.partialTp < tp)) {
      errors.push("partial_tp must be between sl and tp");
    }
  }
  return errors;
}

/** Reject levels that don't fit the live price: already crossed, or far from where the stock trades. */
export function validateAgainstPrice(f: PlanFields, price: number | null): string[] {
  if (price === null) return [];
  const errors: string[] = [];
  if (f.sl !== null && f.sl >= price) {
    errors.push(`stop loss ${f.sl.toFixed(2)} is at or above the current price ${price.toFixed(2)}`);
  }
  // BUY only: for a HOLD/TRIM on a winner, a target already reached is valid advice.
  if (f.action === "BUY" && f.tp !== null && f.tp <= price) {
    errors.push(`take-profit ${f.tp.toFixed(2)} is at or below the current price ${price.toFixed(2)}`);
  }
  if (f.action === "BUY" && f.entryLow !== null && f.entryHigh !== null) {
    const zone = `${f.entryLow.toFixed(2)}-${f.entryHigh.toFixed(2)}`;
    if (f.entryLow > price * (1 + BUY_ZONE_MAX_ABOVE)) {
      errors.push(`buy zone ${zone} starts more than 10% above the current price ${price.toFixed(2)}`);
    } else if (f.entryHigh < price * (1 - BUY_ZONE_MAX_BELOW)) {
      errors.push(`buy zone ${zone} ends more than 25% below the current price ${price.toFixed(2)}`);
    }
  }
  return errors;
}
