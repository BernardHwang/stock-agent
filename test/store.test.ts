import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PlanFields } from "../src/plans";
import { Store } from "../src/store";

const NOW = new Date("2026-11-24T03:00:00Z");
const fields: PlanFields = {
  action: "HOLD", entryLow: null, entryHigh: null, partialTp: null, tp: 400, sl: 300,
  confidence: "medium", holdingMonths: 6, reasoning: "r",
};

describe("Store", () => {
  it("round-trips settings and treats an empty value as unset", async () => {
    const s = new Store(env.DB);
    await s.setSetting("a", "1");
    expect(await s.getSetting("a")).toBe("1");
    await s.setSetting("a", "");
    expect(await s.getSetting("a")).toBeNull();
    expect(await s.getSetting("missing")).toBeNull();
  });

  it("marks a key only once", async () => {
    const s = new Store(env.DB);
    expect(await s.markOnce("k", NOW)).toBe(true);
    expect(await s.markOnce("k", NOW)).toBe(false);
  });

  it("replaces all positions on save", async () => {
    const s = new Store(env.DB);
    await s.savePositions([{ code: "US.A", name: "A", qty: 1, avgCost: 10 }], NOW);
    await s.savePositions([{ code: "US.B", name: "B", qty: 2, avgCost: null }], NOW);
    expect(await s.lastPositions()).toEqual([{ code: "US.B", name: "B", qty: 2, avgCost: null }]);
  });

  it("saves plans and lists the active ones", async () => {
    const s = new Store(env.DB);
    const id = await s.savePlan("US.MDB", fields, "HELD", NOW);
    const [plan] = await s.activePlans();
    expect(plan).toMatchObject({ id, code: "US.MDB", state: "HELD", sl: 300, fired: [], createdAt: NOW.toISOString() });
    await s.updatePlan({ ...plan!, state: "CLOSED" });
    expect(await s.activePlans()).toEqual([]);
  });

  it("persists fired levels", async () => {
    const s = new Store(env.DB);
    await s.savePlan("US.MDB", fields, "HELD", NOW);
    const [plan] = await s.activePlans();
    await s.updatePlan({ ...plan!, fired: ["SL"] });
    expect((await s.activePlans())[0]!.fired).toEqual(["SL"]);
  });
});
