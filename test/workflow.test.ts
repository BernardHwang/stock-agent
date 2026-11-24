import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiRateLimited } from "../src/ai";
import type { Env } from "../src/env";
import { syncHoldings } from "../src/holdings";
import { analysisGate, drainQueue, executeItem, scheduleReviews } from "../src/workflow";
import { Store } from "../src/store";
import { mockFetch, sentTexts, telegramOk } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-24T03:00:00Z"); // Tue 11:00 MYT
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

function withWorkflow(over: Partial<Env> = {}) {
  const create = vi.fn(async (_opts: unknown) => ({ id: "x" }));
  return { e: { ...env, ANALYSIS: { create } as unknown as Workflow, MAX_RUNS_PER_DAY: "2", ...over } as Env, create };
}

describe("drainQueue", () => {
  it("starts the next item and records the run", async () => {
    const store = new Store(env.DB);
    await store.enqueue("US.A", "weekly", 2, NOW);
    await store.enqueue("US.B", "chat", 0, NOW);
    const { e, create } = withWorkflow();
    await drainQueue(e, store, NOW);
    expect(create).toHaveBeenCalledTimes(1);
    const params = (create.mock.calls[0]![0] as { params: { itemId: number } }).params;
    expect((await store.queueItem(params.itemId))!).toMatchObject({ code: "US.B", status: "running" });
    expect(await store.countRunsOn("2026-11-24", "Asia/Kuala_Lumpur")).toBe(1);
  });

  it("starts nothing while one is running, while paused, or at the daily limit", async () => {
    const store = new Store(env.DB);
    await store.enqueue("US.A", "chat", 0, NOW);
    const { e, create } = withWorkflow();
    await drainQueue(e, store, NOW);
    await store.enqueue("US.B", "chat", 0, NOW);
    await drainQueue(e, store, later(1)); // US.A still running
    expect(create).toHaveBeenCalledTimes(1);

    await store.setQueueStatus((await store.runningItems())[0]!.id, "done");
    await store.setSetting("ai_paused_until", later(30).toISOString());
    await drainQueue(e, store, later(2));
    expect(create).toHaveBeenCalledTimes(1);

    await store.setSetting("ai_paused_until", "");
    await store.recordRun("US.Z", NOW); // 2 runs today = MAX_RUNS_PER_DAY
    await drainQueue(e, store, later(3));
    expect(create).toHaveBeenCalledTimes(1);
    expect((await analysisGate(e, store, later(3))).wait).toBe("limit");
  });

  it("fails an analysis stuck running for over 20 minutes and tells the owner", async () => {
    const store = new Store(env.DB);
    await store.enqueue("US.A", "chat", 0, NOW);
    const id = (await store.nextQueued())!.id;
    const { e } = withWorkflow();
    const sent = mockFetch(telegramOk);
    await drainQueue(e, store, NOW);
    await drainQueue(e, store, later(21));
    expect((await store.queueItem(id))!.status).toBe("failed");
    expect(sentTexts(sent)[0]).toContain("US.A");
  });
});

describe("executeItem", () => {
  const item = async (store: Store) => {
    await store.enqueue("US.A", "chat", 0, NOW);
    const it = (await store.nextQueued())!;
    await store.setQueueStatus(it.id, "running");
    await store.recordRun("US.A", NOW);
    return it;
  };

  it("puts a rate-limited analysis back, pauses for 30 minutes, and refunds a run with no paid AI call", async () => {
    const store = new Store(env.DB);
    const it = await item(store);
    await executeItem(env, store, it.id, NOW.toISOString(), () => later(0.5), async () => { throw new AiRateLimited("3040"); });
    expect((await store.queueItem(it.id))!.status).toBe("pending");
    expect(await store.getSetting("ai_paused_until")).toBe(later(30.5).toISOString());
    expect(await store.countRunsOn("2026-11-24", "Asia/Kuala_Lumpur")).toBe(0);
  });

  it("keeps the run counted once an AI call was paid for", async () => {
    const store = new Store(env.DB);
    const it = await item(store);
    await store.setSetting(`analysis_paid:${it.id}`, "1");
    await executeItem(env, store, it.id, NOW.toISOString(), () => later(5), async () => { throw new AiRateLimited("3040"); });
    expect(await store.countRunsOn("2026-11-24", "Asia/Kuala_Lumpur")).toBe(1);
  });

  it("marks other failures failed and tells the owner without the error text", async () => {
    const store = new Store(env.DB);
    const it = await item(store);
    const sent = mockFetch(telegramOk);
    await executeItem(env, store, it.id, NOW.toISOString(), () => later(1), async () => { throw new TypeError("secret detail"); });
    expect((await store.queueItem(it.id))!.status).toBe("failed");
    expect(sentTexts(sent)[0]).toContain("US.A");
    expect(sentTexts(sent)[0]).toContain("TypeError");
    expect(sentTexts(sent)[0]).not.toContain("secret detail");
  });
});

describe("triggers", () => {
  it("queues a new holding for analysis once", async () => {
    const store = new Store(env.DB);
    await syncHoldings(store, [{ code: "US.AMD", name: "AMD", qty: 1, avgCost: 100 }], NOW);
    await syncHoldings(store, [{ code: "US.AMD", name: "AMD", qty: 1, avgCost: 100 }], NOW);
    expect((await store.pendingItems()).map((i) => [i.code, i.reason, i.priority])).toEqual([["US.AMD", "new_holding", 1]]);
  });

  it("queues every holding for the Monday 20:00 review, once", async () => {
    const store = new Store(env.DB);
    await store.savePositions([{ code: "US.A", name: "A", qty: 1, avgCost: 1 }, { code: "US.B", name: "B", qty: 1, avgCost: 1 }], NOW);
    const monday8pm = new Date("2026-11-30T12:00:00Z"); // Mon 20:00 MYT
    await scheduleReviews(env, store, new Date("2026-11-30T11:59:00Z"));
    expect(await store.pendingItems()).toEqual([]);
    await scheduleReviews(env, store, monday8pm);
    await scheduleReviews(env, store, new Date("2026-11-30T12:01:00Z")); // a minute later: already done
    expect((await store.pendingItems()).map((i) => [i.code, i.reason])).toEqual([["US.A", "weekly"], ["US.B", "weekly"]]);
  });
});

describe("review fixes", () => {
  const running = async (store: Store) => {
    await store.enqueue("US.A", "chat", 0, NOW);
    const it = (await store.nextQueued())!;
    await store.setQueueStatus(it.id, "running");
    await store.recordRun("US.A", NOW);
    return it;
  };

  it("recognises a rate limit that Workflows re-created as a plain Error", async () => {
    const store = new Store(env.DB);
    const it = await running(store);
    await executeItem(env, store, it.id, NOW.toISOString(), () => later(3),
      async () => { throw new Error("AiRateLimited: 3040: Capacity temporarily exceeded"); });
    expect((await store.queueItem(it.id))!.status).toBe("pending");
    expect(await store.getSetting("ai_paused_until")).toBe(later(33).toISOString());
  });

  it("refunds the run and names the stock when it fails before any AI call", async () => {
    const store = new Store(env.DB);
    const it = await running(store);
    const sent = mockFetch(telegramOk);
    await executeItem(env, store, it.id, NOW.toISOString(), () => later(3), async () => { throw new Error("no price for US.A"); });
    expect(await store.countRunsOn("2026-11-24", "Asia/Kuala_Lumpur")).toBe(0);
    expect(sentTexts(sent)[0]).toContain("US.A");
  });

  it("terminates a stuck Workflow, and a late failure can't bring the item back", async () => {
    const store = new Store(env.DB);
    await store.enqueue("US.A", "chat", 0, NOW);
    const id = (await store.nextQueued())!.id;
    const terminate = vi.fn(async () => {});
    const get = vi.fn(async (_id: string) => ({ terminate }));
    const create = vi.fn(async (_o: { id: string }) => ({ id: "x" }));
    const e = { ...env, ANALYSIS: { create, get } as unknown as Workflow } as Env;
    mockFetch(telegramOk);
    await drainQueue(e, store, NOW);
    const instanceId = create.mock.calls[0]![0].id;
    expect(instanceId).toMatch(/^item-/);
    await drainQueue(e, store, later(21));
    expect(get).toHaveBeenCalledWith(instanceId);
    expect(terminate).toHaveBeenCalled();
    await executeItem(e, store, id, NOW.toISOString(), () => later(22), async () => { throw new Error("3040 capacity"); });
    expect((await store.queueItem(id))!.status).toBe("failed");
  });

  it("starts analyses only below 8,000 neurons, leaving room to finish one", async () => {
    const store = new Store(env.DB);
    await store.setSetting(`neurons:${NOW.toISOString().slice(0, 10)}`, "8100");
    expect((await analysisGate(env, store, NOW)).wait).toBe("neurons");
  });
});
