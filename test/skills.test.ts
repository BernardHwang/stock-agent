import { describe, expect, it } from "vitest";
import { ROLES, SHARED_RULE, SKILLS } from "../src/skills";

const TARGET_RULE = "at least 20% above the entry and at least twice as far above it as the stop is below it";

describe("skills", () => {
  it("has a non-empty instruction for every role", () => {
    expect(ROLES).toHaveLength(11);
    for (const role of ROLES) expect(SKILLS[role].trim().length, role).toBeGreaterThan(200);
  });

  it("gives every role the shared data rule", () => {
    for (const role of ROLES) expect(SKILLS[role], role).toContain(SHARED_RULE);
  });

  it("asks the portfolio manager for the plan JSON", () => {
    for (const field of ['"action"', '"entry_low"', '"entry_high"', '"partial_tp"', '"tp"', '"sl"', '"confidence"',
      '"holding_months"', '"trim_pct"', '"reasoning"']) {
      expect(SKILLS.portfolio_manager).toContain(field);
    }
  });

  it("makes the decision roles judge a holding against its cost, not as a fresh buy", () => {
    for (const role of ["research_manager", "trader", "risk_aggressive", "risk_neutral", "risk_conservative"] as const) {
      expect(SKILLS[role], role).toContain("If the investor already holds the stock");
    }
  });

  it("defines each confidence level", () => {
    for (const level of ["- high:", "- medium:", "- low:"]) expect(SKILLS.portfolio_manager).toContain(level);
  });

  it("keeps HOLD-as-pass for stocks the investor doesn't hold", () =>
    expect(SKILLS.portfolio_manager).toMatch(/If the investor does not hold the stock and the evidence does not support/));

  it("gives the trader levels for a holding and one target rule shared with the portfolio manager", () => {
    expect(SKILLS.trader).toContain("For a hold or trim");
    expect(SKILLS.trader).toContain(TARGET_RULE);
    expect(SKILLS.portfolio_manager).toContain(TARGET_RULE);
  });

  it("tells the portfolio manager to weigh the investor's average cost", () =>
    expect(SKILLS.portfolio_manager).toMatch(/A HOLD's tp must be at or above the\s+investor's average cost/));
});
