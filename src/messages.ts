/** Plain-text Telegram messages for analysis results. */
import type { Plan, PlanFields } from "./plans";

const money = (v: number) => v.toFixed(2);
const vs = (level: number, price: number) => {
  const p = ((level - price) / price) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
};

export function formatPlan(plan: Plan, price: number): string {
  const lines = [
    `📈 Plan for ${plan.code}: ${plan.action} (${plan.confidence} confidence)${plan.state === "HELD" ? ", for your holding" : ""}`,
    `Price now: ${money(price)}`,
  ];
  if (plan.entryLow !== null && plan.entryHigh !== null) {
    lines.push(`Buy zone: ${money(plan.entryLow)} - ${money(plan.entryHigh)}`);
  }
  if (plan.partialTp !== null) lines.push(`Partial take-profit: ${money(plan.partialTp)} (${vs(plan.partialTp, price)})`);
  if (plan.tp !== null) lines.push(`Take-profit: ${money(plan.tp)} (${vs(plan.tp, price)})`);
  if (plan.sl !== null) lines.push(`Stop-loss: ${money(plan.sl)} (${vs(plan.sl, price)}); I'll warn you if it's hit`);
  if (plan.holdingMonths) lines.push(`Time frame: about ${plan.holdingMonths} months`);
  lines.push("", plan.reasoning, "", "Ask me about it any time, e.g. \"why this plan?\"");
  return lines.join("\n");
}

/** An analysis whose action needs no plan (e.g. HOLD or EXIT on a stock you don't own). */
export function formatNoPlan(code: string, f: PlanFields): string {
  return `🤔 ${code}: ${f.action} (${f.confidence} confidence). No plan saved, since you don't hold it.\n\n${f.reasoning}`;
}

export function formatInvalidPlan(code: string, errors: string[]): string {
  return [`The analysis for ${code} finished, but its levels didn't pass my checks, so no plan was saved:`,
    ...errors.map((e) => `• ${e}`), "", "The full report is saved; ask me about it."].join("\n");
}
