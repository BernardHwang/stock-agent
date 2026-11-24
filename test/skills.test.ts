import { describe, expect, it } from "vitest";
import { ROLES, SHARED_RULE, SKILLS } from "../src/skills";

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
      '"holding_months"', '"reasoning"']) {
      expect(SKILLS.portfolio_manager).toContain(field);
    }
  });
});
