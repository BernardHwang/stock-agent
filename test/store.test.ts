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

describe("analysis queue, runs and reports", () => {
  it("queues a code once until its item is done", async () => {
    const s = new Store(env.DB);
    expect(await s.enqueue("US.MDB", "chat", 0, NOW)).toBe(true);
    expect(await s.enqueue("US.MDB", "weekly", 2, NOW)).toBe(false);
    const item = (await s.nextQueued())!;
    await s.setQueueStatus(item.id, "done");
    expect(await s.enqueue("US.MDB", "chat", 0, NOW)).toBe(true);
  });

  it("serves the lowest priority first, then the oldest", async () => {
    const s = new Store(env.DB);
    await s.enqueue("US.A", "weekly", 3, NOW);
    await s.enqueue("US.B", "weekly", 3, new Date(NOW.getTime() + 1000));
    await s.enqueue("US.C", "chat", 0, new Date(NOW.getTime() + 2000));
    expect((await s.nextQueued())!.code).toBe("US.C");
    await s.setQueueStatus((await s.nextQueued())!.id, "running");
    expect((await s.nextQueued())!.code).toBe("US.A");
    expect(await s.isRunning()).toBe(true);
  });

  it("counts runs by the owner's local day and can forget one", async () => {
    const s = new Store(env.DB);
    const a = new Date("2026-11-24T16:30:00Z"); // 00:30 MYT on 11-25
    await s.recordRun("US.A", a);
    await s.recordRun("US.B", new Date("2026-11-24T15:30:00Z")); // 23:30 MYT on 11-24
    expect(await s.countRunsOn("2026-11-25", "Asia/Kuala_Lumpur")).toBe(1);
    await s.forgetRun("US.A", a);
    expect(await s.countRunsOn("2026-11-25", "Asia/Kuala_Lumpur")).toBe(0);
  });

  it("keeps the newest report per code", async () => {
    const s = new Store(env.DB);
    await s.saveReport("US.MDB", "old", 300, NOW);
    await s.saveReport("US.MDB", "new", 316, new Date(NOW.getTime() + 1000));
    expect(await s.loadReport("US.MDB")).toMatchObject({ text: "new", price: 316 });
    expect(await s.loadReport("US.X")).toBeNull();
  });

  it("finds the active plan for a code", async () => {
    const s = new Store(env.DB);
    expect(await s.planFor("US.MDB")).toBeNull();
    await s.savePlan("US.MDB", fields, "HELD", NOW);
    expect((await s.planFor("US.MDB"))!.state).toBe("HELD");
  });
});
