/** Plain-text Telegram messages for analysis results. */
import type { Plan, PlanFields } from "./plans";

const money = (v: number) => v.toFixed(2);
const vs = (level: number, price: number) => {
  const p = ((level - price) / price) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
};

/** The plan as a Telegram message; with ``avgCost`` every level is also measured from what the investor paid. */
export function formatPlan(plan: Plan, price: number, avgCost: number | null = null): string {
  const cost = avgCost !== null && avgCost > 0 ? avgCost : null;
  const from = (level: number) => (cost === null ? vs(level, price) : `${vs(level, price)} vs now, ${vs(level, cost)} vs your cost`);
  const lines = [
    `📈 **Plan for ${plan.code}: ${plan.action}** (${plan.confidence} confidence)${plan.state === "HELD" ? ", for your holding" : ""}`,
    `Price now: ${money(price)}`,
  ];
  if (cost !== null) lines.push(`Your average cost: ${money(cost)}`);
  if (plan.entryLow !== null && plan.entryHigh !== null) {
    lines.push(`Buy zone: ${money(plan.entryLow)} - ${money(plan.entryHigh)}`);
  }
  if (plan.partialTp !== null) lines.push(`Partial take-profit: ${money(plan.partialTp)} (${from(plan.partialTp)})`);
  if (plan.tp !== null) lines.push(`Take-profit: ${money(plan.tp)} (${from(plan.tp)})`);
  if (plan.sl !== null) lines.push(`Stop-loss: ${money(plan.sl)} (${from(plan.sl)}); I'll warn you if it's hit`);
  if (plan.holdingMonths) lines.push(`Time frame: about ${plan.holdingMonths} months`);
  if (cost !== null && plan.tp !== null && plan.tp < cost) {
    lines.push("", `⚠️ **This take-profit is below your average cost**, so selling there would lock in a loss.`);
  }
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
