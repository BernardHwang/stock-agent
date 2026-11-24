import { describe, expect, it } from "vitest";
import { type PlanFields, validateAgainstPrice, validateFields } from "../src/plans";

const buy = (kw: Partial<PlanFields> = {}): PlanFields => ({
  action: "BUY", entryLow: 100, entryHigh: 105, partialTp: null, tp: 130, sl: 90,
  confidence: "medium", holdingMonths: 6, reasoning: "r", ...kw,
});
const none = { entryLow: null, entryHigh: null, partialTp: null } as const;

describe("validateFields", () => {
  it("accepts a valid buy", () => expect(validateFields(buy())).toEqual([]));
  it("rejects a stop at or above the entry zone", () => expect(validateFields(buy({ sl: 101 }))).not.toEqual([]));
  it("rejects a target inside the entry zone", () => expect(validateFields(buy({ tp: 104 }))).not.toEqual([]));
  it("rejects a buy with missing levels", () =>
    expect(validateFields(buy({ tp: null }))).toEqual(["BUY needs entry_low, entry_high, tp and sl"]));
  it("needs partial_tp between the zone and tp", () => {
    expect(validateFields(buy({ partialTp: 140 }))).not.toEqual([]);
    expect(validateFields(buy({ partialTp: 104 }))).not.toEqual([]);
    expect(validateFields(buy({ partialTp: 118 }))).toEqual([]);
  });
  it("needs entry_low <= entry_high", () =>
    expect(validateFields(buy({ entryLow: 110 }))).toContain("entry_low must not exceed entry_high"));
  it("rejects non-positive prices", () => expect(validateFields(buy({ sl: 0 }))).toEqual(["sl must be positive"]));
  it("needs sl below tp on a hold", () => {
    const hold: PlanFields = { ...buy(), ...none, action: "HOLD", tp: 100, sl: 120, confidence: "low", holdingMonths: 3 };
    expect(validateFields(hold)).toEqual(["sl must be below tp"]);
  });
  it("needs tp and sl on a hold", () =>
    expect(validateFields({ ...buy(), ...none, action: "HOLD", tp: null })).toEqual(["HOLD needs tp and sl"]));
  it("needs no levels on an exit", () =>
    expect(validateFields({ ...buy(), ...none, action: "EXIT", tp: null, sl: null, holdingMonths: 0 })).toEqual([]));
});

describe("validateAgainstPrice", () => {
  const big = (kw: Partial<PlanFields> = {}) =>
    buy({ entryLow: 420, entryHigh: 450, tp: 580, sl: 380, confidence: "high", ...kw });

  it("rejects a buy zone far above the live price (the real MDB case)", () =>
    expect(validateAgainstPrice(big({ sl: 300 }), 316).some((e) => e.includes("buy zone"))).toBe(true));
  it("rejects a buy zone far below the live price", () =>
    expect(validateAgainstPrice(big({ entryLow: 200, entryHigh: 220, sl: 180, tp: 380 }), 316)
      .some((e) => e.includes("buy zone"))).toBe(true));
  it("accepts a buy zone near the live price", () =>
    expect(validateAgainstPrice(big({ entryLow: 295, entryHigh: 320, sl: 270, tp: 400 }), 316)).toEqual([]));
  it("rejects a buy whose take-profit is already reached", () =>
    expect(validateAgainstPrice(big({ entryLow: 290, entryHigh: 300, sl: 270, tp: 310 }), 316)
      .some((e) => e.includes("take-profit"))).toBe(true));
  it("rejects a stop at or above the live price", () =>
    expect(validateAgainstPrice(big({ entryLow: 290, entryHigh: 300, sl: 320, tp: 400 }), 316)
      .some((e) => e.includes("stop loss"))).toBe(true));
  it("accepts a trim whose target is already reached", () => {
    const trim: PlanFields = { ...buy(), ...none, action: "TRIM", tp: 300, sl: 250 };
    expect(validateAgainstPrice(trim, 316)).toEqual([]);
  });
  it("skips the checks without a live price", () => expect(validateAgainstPrice(big(), null)).toEqual([]));
});
