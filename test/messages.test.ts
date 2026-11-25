import { describe, expect, it } from "vitest";
import { formatPlan } from "../src/messages";
import type { Plan } from "../src/plans";

const plan = (kw: Partial<Plan> = {}): Plan => ({
  id: 1, code: "US.MDB", state: "HELD", createdAt: "2026-11-24", fired: [],
  action: "HOLD", entryLow: null, entryHigh: null, partialTp: null, tp: 340, sl: 280,
  confidence: "medium", holdingMonths: 6, reasoning: "r", ...kw,
});

describe("formatPlan", () => {
  it("measures levels from the current price only when there is no cost", () => {
    const text = formatPlan(plan(), 316);
    expect(text).toContain("Take-profit: 340.00 (+7.6%)");
    expect(text).toContain("Stop-loss: 280.00 (-11.4%)");
    expect(text).not.toContain("your cost");
  });

  it("measures levels from both the current price and the investor's average cost", () => {
    const text = formatPlan(plan({ partialTp: 330 }), 316, 358.09);
    expect(text).toContain("Your average cost: 358.09");
    expect(text).toContain("Partial take-profit: 330.00 (+4.4% vs now, -7.8% vs your cost)");
    expect(text).toContain("Take-profit: 340.00 (+7.6% vs now, -5.1% vs your cost)");
    expect(text).toContain("Stop-loss: 280.00 (-11.4% vs now, -21.8% vs your cost)");
  });

  it("warns when the take-profit is below the average cost", () => {
    expect(formatPlan(plan(), 316, 358.09)).toContain("below your average cost");
    expect(formatPlan(plan({ tp: 400 }), 316, 358.09)).not.toContain("below your average cost");
  });
});
