import { describe, expect, it, vi } from "vitest";
import { extractPlan, parsePlan, RETRY_NOTE } from "../src/extract";

const plan = (kw: Record<string, unknown> = {}) => JSON.stringify({
  action: "BUY", entry_low: 300, entry_high: 315, partial_tp: 360, tp: 390, sl: 270,
  confidence: "medium", holding_months: 6, reasoning: "Accumulate near support.", ...kw,
});

describe("parsePlan", () => {
  it("reads plain JSON into plan fields", () => {
    expect(parsePlan(plan())).toEqual({
      action: "BUY", entryLow: 300, entryHigh: 315, partialTp: 360, tp: 390, sl: 270,
      confidence: "medium", holdingMonths: 6, trimPct: null, reasoning: "Accumulate near support.",
    });
  });

  it("reads JSON inside code fences or surrounded by prose", () => {
    expect(parsePlan("```json\n" + plan() + "\n```").tp).toBe(390);
    expect(parsePlan("Here is my plan:\n" + plan() + "\nGood luck!").sl).toBe(270);
  });

  it("treats missing levels as null and accepts numeric strings", () => {
    const f = parsePlan(JSON.stringify({ action: "EXIT", confidence: "high", holding_months: "0", reasoning: "r", tp: "" }));
    expect(f).toMatchObject({ action: "EXIT", entryLow: null, tp: null, sl: null, holdingMonths: 0 });
  });

  it("reads the trim size, rounded to a whole percent, and ignores it for other actions", () => {
    expect(parsePlan(plan({ action: "TRIM", trim_pct: "33.4" })).trimPct).toBe(33);
    expect(parsePlan(plan({ trim_pct: 25 })).trimPct).toBeNull();
  });

  it("cuts long reasoning to 600 characters", () => {
    const f = parsePlan(plan({ reasoning: "x".repeat(2000) }));
    expect(f.reasoning.length).toBe(600);
    expect(f.reasoning.endsWith("…")).toBe(true);
  });

  it("rejects text without a plan or with an unknown action", () => {
    expect(() => parsePlan("I think you should buy.")).toThrow();
    expect(() => parsePlan(plan({ action: "SHORT" }))).toThrow();
    expect(() => parsePlan(plan({ confidence: "very" }))).toThrow();
  });
});

describe("extractPlan", () => {
  it("accepts a valid plan on the first answer", async () => {
    const askPm = vi.fn(async () => plan());
    expect(await extractPlan(askPm, 316)).toEqual({ fields: parsePlan(plan()) });
    expect(askPm).toHaveBeenCalledTimes(1);
  });

  it("retries once with the errors, then accepts the corrected plan", async () => {
    const askPm = vi.fn<(extra: string) => Promise<string>>()
      .mockResolvedValueOnce(plan({ sl: 320 })) // stop above the entry zone
      .mockResolvedValueOnce(plan());
    const out = await extractPlan(askPm, 316);
    expect("fields" in out).toBe(true);
    expect(askPm).toHaveBeenCalledTimes(2);
    expect(askPm.mock.calls[1]![0]).toContain(RETRY_NOTE);
    expect(askPm.mock.calls[1]![0]).toContain("sl must be below the entry zone");
  });

  it("gives up after the retry and returns the errors", async () => {
    const askPm = vi.fn(async () => plan({ entry_low: 420, entry_high: 450, partial_tp: null, tp: 580, sl: 380 }));
    const out = await extractPlan(askPm, 316);
    expect(out).toEqual({ errors: expect.arrayContaining([expect.stringContaining("buy zone")]) });
    expect(askPm).toHaveBeenCalledTimes(2);
  });

  it("tells the retry that a hold's take-profit is below the investor's average cost", async () => {
    const hold = plan({ action: "HOLD", entry_low: null, entry_high: null, partial_tp: null, tp: 340, sl: 280 });
    const askPm = vi.fn<(extra: string) => Promise<string>>().mockResolvedValueOnce(hold)
      .mockResolvedValueOnce(plan({ action: "TRIM", entry_low: null, entry_high: null, partial_tp: null, tp: 340, sl: 280, trim_pct: 25 }));
    const out = await extractPlan(askPm, 316, 358.09);
    expect(out).toMatchObject({ fields: { action: "TRIM" } });
    expect(askPm.mock.calls[1]![0]).toContain("average cost 358.09");
    expect(askPm.mock.calls[1]![0]).toContain("TRIM or EXIT");
  });

  it("retries when the first answer is not JSON at all", async () => {
    const askPm = vi.fn<(extra: string) => Promise<string>>().mockResolvedValueOnce("Sorry, no plan.").mockResolvedValueOnce(plan());
    expect("fields" in (await extractPlan(askPm, 316))).toBe(true);
  });
});
