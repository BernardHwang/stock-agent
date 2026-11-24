import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { syncHoldings } from "../src/holdings";
import type { PlanFields } from "../src/plans";
import { type Position, Store } from "../src/store";

const NOW = new Date("2026-11-06T02:00:00Z");
const buy: PlanFields = {
  action: "BUY", entryLow: 100, entryHigh: 105, partialTp: null, tp: 130, sl: 90,
  confidence: "medium", holdingMonths: 6, reasoning: "r",
};
const pos = (code = "US.NVDA", qty = 10, avgCost = 102): Position => ({ code, name: code, qty, avgCost });

async function storeWithBuyPlan() {
  const store = new Store(env.DB);
  await store.savePlan("US.NVDA", buy, "OPEN", NOW);
  return store;
}
const planOf = async (store: Store, code: string) => (await store.activePlans()).find((p) => p.code === code);

describe("syncHoldings", () => {
  it("links a buy plan when the stock is bought in its zone", async () => {
    const store = await storeWithBuyPlan();
    const messages = await syncHoldings(store, [pos()], NOW);
    expect(await planOf(store, "US.NVDA")).toMatchObject({ state: "HELD", action: "HOLD" });
    expect(messages).toHaveLength(1);
  });

  it("closes a plan after a full sell, but only on the second empty read", async () => {
    const store = await storeWithBuyPlan();
    await syncHoldings(store, [pos()], NOW);
    expect(await syncHoldings(store, [], NOW)).toEqual([]);
    expect((await planOf(store, "US.NVDA"))?.state).toBe("HELD");
    await syncHoldings(store, [], NOW);
    expect(await planOf(store, "US.NVDA")).toBeUndefined();
  });

  it("does not re-announce holdings after an empty-read glitch", async () => {
    const store = await storeWithBuyPlan();
    await syncHoldings(store, [pos()], NOW);
    await syncHoldings(store, [], NOW);
    expect(await syncHoldings(store, [pos()], NOW)).toEqual([]);
    await syncHoldings(store, [], NOW); // the earlier empty read must not count towards this one
    expect((await planOf(store, "US.NVDA"))?.state).toBe("HELD");
  });

  it("closes immediately when one of several holdings is sold", async () => {
    const store = await storeWithBuyPlan();
    await syncHoldings(store, [pos(), pos("US.AMD")], NOW);
    await syncHoldings(store, [pos("US.AMD")], NOW);
    expect(await planOf(store, "US.NVDA")).toBeUndefined();
  });

  it("keeps the plan on a partial sell", async () => {
    const store = await storeWithBuyPlan();
    await syncHoldings(store, [pos("US.NVDA", 10)], NOW);
    expect(await syncHoldings(store, [pos("US.NVDA", 4)], NOW)).toEqual([]);
    expect((await store.lastPositions())[0]!.qty).toBe(4);
  });

  it("announces an untracked holding once", async () => {
    const store = new Store(env.DB);
    const messages = await syncHoldings(store, [pos("US.AMD")], NOW);
    expect(messages).toEqual(["Now tracking your position in US.AMD. I've queued an analysis to set its target and stop-loss."]);
    expect(await syncHoldings(store, [pos("US.AMD")], NOW)).toEqual([]);
  });

  it("retires a buy plan when the stock was bought far from its zone", async () => {
    const store = await storeWithBuyPlan();
    const messages = await syncHoldings(store, [pos("US.NVDA", 10, 358)], NOW);
    expect(await planOf(store, "US.NVDA")).toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("far from plan");
  });

  it("keeps a linked plan when averaging down", async () => {
    const store = await storeWithBuyPlan();
    await syncHoldings(store, [pos("US.NVDA", 10, 102)], NOW);
    await syncHoldings(store, [pos("US.NVDA", 30, 80)], NOW);
    expect(await planOf(store, "US.NVDA")).toMatchObject({ state: "HELD", action: "HOLD" });
  });
});

describe("/moomoo sync", () => {
  it("reads positions, reports changes and records the sync time", async () => {
    const { vi } = await import("vitest");
    const { handleUpdate } = await import("../src/commands");
    const { mockFetch, sentTexts, telegramOk } = await import("./helpers");
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r");
    await store.setSetting("moomoo_access", "tok");
    await store.setSetting("moomoo_access_until", "2026-11-06T05:00:00Z");
    const raw = (t: string) => new Response(t);
    const calls = mockFetch((url) => telegramOk(url) ??
      (url.endsWith("/authorized_trd_accs") ? raw('{"s":"ok","d":{"accounts":[{"account_id":7}]}}')
        : url.includes("/7/positions") ? raw('{"s":"ok","d":[{"code":"US.MDB","stock_name":"MongoDB","qty":7,"cost_price":358.09}]}')
        : undefined));
    await handleUpdate(env, store, { message: { chat: { id: 1001 }, text: "/moomoo sync" } }, NOW, "https://worker.test");
    expect(sentTexts(calls)).toEqual(["Now tracking your position in US.MDB. I've queued an analysis to set its target and stop-loss.\n\nSynced 1 position from moomoo."]);
    expect(await store.lastPositions()).toEqual([{ code: "US.MDB", name: "MongoDB", qty: 7, avgCost: 358.09 }]);
    expect(await store.getSetting("last_sync")).toBe(NOW.toISOString());
    vi.restoreAllMocks();
  });
});
