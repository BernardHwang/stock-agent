import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyNewAnalysis } from "../src/lifecycle";
import type { PlanFields } from "../src/plans";
import { Store } from "../src/store";

// Ported from tests/test_lifecycle.py at 9c81be3.
const NOW = new Date("2026-11-06T10:00:00Z");
const buy = (kw: Partial<PlanFields> = {}): PlanFields => ({
  action: "BUY", entryLow: 100, entryHigh: 105, partialTp: null, tp: 130, sl: 90,
  confidence: "medium", holdingMonths: 6, trimPct: null, reasoning: "r", ...kw,
});
const hold = (kw: Partial<PlanFields> = {}): PlanFields =>
  buy({ action: "HOLD", entryLow: null, entryHigh: null, ...kw });

describe("applyNewAnalysis", () => {
  it("creates an OPEN plan for a buy without a plan", async () => {
    const p = await applyNewAnalysis(new Store(env.DB), "US.NVDA", buy(), false, NOW);
    expect(p).toMatchObject({ state: "OPEN", action: "BUY" });
    expect(p!.id).toBeGreaterThan(0);
  });

  it("replaces an OPEN plan with a new buy", async () => {
    const store = new Store(env.DB);
    const old = (await applyNewAnalysis(store, "US.NVDA", buy(), false, NOW))!;
    const fresh = (await applyNewAnalysis(store, "US.NVDA", buy({ tp: 140 }), false, NOW))!;
    expect((await store.getPlan(old.id))!.state).toBe("EXPIRED");
    expect((await store.planFor("US.NVDA"))!.id).toBe(fresh.id);
  });

  it("re-arms fired levels when the exit levels change", async () => {
    const store = new Store(env.DB);
    const p = (await applyNewAnalysis(store, "US.NVDA", buy(), false, NOW))!;
    await store.updatePlan({ ...p, state: "HELD", fired: ["SL"] });
    const updated = (await applyNewAnalysis(store, "US.NVDA", hold({ sl: 95 }), true, NOW))!;
    expect(updated).toMatchObject({ id: p.id, fired: [], sl: 95 });
  });

  it("keeps fired levels when the exit levels are the same", async () => {
    const store = new Store(env.DB);
    const p = (await applyNewAnalysis(store, "US.NVDA", buy(), false, NOW))!;
    await store.updatePlan({ ...p, state: "HELD", fired: ["SL"] });
    expect((await applyNewAnalysis(store, "US.NVDA", hold(), true, NOW))!.fired).toEqual(["SL"]);
  });

  it("keeps a held plan HELD on a buy signal, as a HOLD with the new levels", async () => {
    const store = new Store(env.DB);
    const p = (await applyNewAnalysis(store, "US.NVDA", buy(), false, NOW))!;
    await store.updatePlan({ ...p, state: "HELD" });
    const updated = (await applyNewAnalysis(store, "US.NVDA", buy({ tp: 150 }), true, NOW))!;
    expect(updated).toMatchObject({ state: "HELD", action: "HOLD", tp: 150 });
  });

  it("does not save an exit for a stock that isn't held", async () => {
    const store = new Store(env.DB);
    const exit: PlanFields = { ...hold(), action: "EXIT", tp: null, sl: null, holdingMonths: 0 };
    expect(await applyNewAnalysis(store, "US.NVDA", exit, false, NOW)).toBeNull();
    expect(await store.planFor("US.NVDA")).toBeNull();
  });

  it("makes a held stock without a plan a HELD plan, turning BUY into HOLD", async () => {
    const p = await applyNewAnalysis(new Store(env.DB), "US.AMD", buy(), true, NOW);
    expect(p).toMatchObject({ state: "HELD", action: "HOLD" });
  });
});
