import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { checkConsensus, checkEvents } from "../src/events";
import type { PlanFields } from "../src/plans";
import { Store } from "../src/store";
import { mockFetch, sentTexts } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-24T15:00:00Z"); // Tue 10:00 EST, 23:00 MYT
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const hold: PlanFields = {
  action: "HOLD", entryLow: null, entryHigh: null, partialTp: null, tp: 400, sl: 250,
  confidence: "medium", holdingMonths: 6, trimPct: null, reasoning: "r",
};

async function setup() {
  const store = new Store(env.DB);
  await store.setSetting("moomoo_refresh", "r");
  await store.setSetting("moomoo_access", "tok");
  await store.setSetting("moomoo_access_until", "2026-12-31T00:00:00Z");
  await store.savePositions([{ code: "US.MDB", name: "MongoDB", qty: 7, avgCost: 358 }], NOW);
  await store.savePlan("US.MDB", hold, "HELD", NOW);
  const ai = { run: vi.fn(async () => ({ response: "It matters for your stop.", usage: {} })) };
  return { store, e: { ...env, AI: ai as unknown as Ai } as Env, ai };
}

type World = { change?: Record<string, number>; news?: Record<string, string[]>; average?: number; rating?: number };
function world(w: World) {
  return mockFetch((url) => {
    if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true });
    if (url.startsWith("https://query1.finance.yahoo.com/")) {
      const symbol = new URL(url).searchParams.get("q")!;
      const titles = w.news?.[`US.${symbol}`] ?? [];
      return Response.json({ news: titles.map((title) => ({ title, publisher: "Reuters", providerPublishTime: NOW.getTime() / 1000 - 3600 })) });
    }
    if (url.endsWith("/quote/snapshot")) {
      const codes = ["US.MDB", "US.NVDA"];
      return Response.json({ ret_code: 0, ret_msg: "success", data: { snapshot_list: codes.map((code) => ({
        code, name: code === "US.MDB" ? "MongoDB" : "NVIDIA Corporation", prev_close_price: 100, last_price: 100 + (w.change?.[code] ?? 0),
      })) } });
    }
    if (url.includes("/analyst-consensus")) {
      return Response.json({ ret_code: 0, ret_msg: "success", data: { total: 30, rating: w.rating ?? 5, average: w.average ?? 461, highest: 500, lowest: 400 } });
    }
    return undefined;
  });
}

describe("checkEvents", () => {
  it("sends a major relevant headline once", async () => {
    const { store, e } = await setup();
    const calls = world({ news: { "US.MDB": ["MongoDB cuts guidance"] } });
    expect(await checkEvents(e, store, NOW)).toHaveLength(1);
    expect(await checkEvents(e, store, later(30))).toEqual([]);
    expect(sentTexts(calls)[0]).toContain("MongoDB cuts guidance");
    expect(sentTexts(calls)[0]).toContain("So what: It matters for your stop.");
    expect((await store.recentChat(1))[0]!.role).toBe("alert");
  });

  it("ignores headlines about other companies or without news value", async () => {
    const { store, e } = await setup();
    world({ news: { "US.MDB": ["Central Garden & Pet earnings beat", "MongoDB: 5 things to know"] } });
    expect(await checkEvents(e, store, NOW)).toEqual([]);
  });

  it("sends a 5% move once a day", async () => {
    const { store, e } = await setup();
    world({ change: { "US.MDB": -6 } });
    const [note] = await checkEvents(e, store, NOW);
    expect(note).toContain("US.MDB is down 6.00% today at 94.00");
    expect(await checkEvents(e, store, later(30))).toEqual([]);
  });

  it("sends at most 3 events a day", async () => {
    const { store, e } = await setup();
    await store.setSetting("events:2026-11-24", "3");
    const calls = world({ change: { "US.MDB": -6 } });
    expect(await checkEvents(e, store, NOW)).toEqual([]);
    expect(sentTexts(calls)).toEqual([]);
  });

  it("skips the AI line at 8,600 neurons", async () => {
    const { store, e, ai } = await setup();
    await store.setSetting("neurons:2026-11-24", "8600");
    world({ change: { "US.MDB": -6 } });
    const [note] = await checkEvents(e, store, NOW);
    expect(note).not.toContain("So what");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("queues one fresh analysis a day for an event on a held stock", async () => {
    const { store, e } = await setup();
    world({ change: { "US.MDB": -6 }, news: { "US.MDB": ["MongoDB cuts guidance"] } });
    const notes = await checkEvents(e, store, NOW);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("I've queued a fresh analysis.");
    expect(notes[1]).not.toContain("queued");
    expect((await store.pendingItems()).map((i) => [i.code, i.reason])).toEqual([["US.MDB", "event"]]);
  });

  it("queues nothing for a stock that isn't held", async () => {
    const { store, e } = await setup();
    await store.savePlan("US.NVDA", { ...hold, action: "BUY", entryLow: 90, entryHigh: 95, tp: 130, sl: 80 }, "OPEN", NOW);
    world({ change: { "US.NVDA": -6 } });
    const [note] = await checkEvents(e, store, NOW);
    expect(note).toContain("US.NVDA is down 6.00%");
    expect(await store.pendingItems()).toEqual([]);
  });
});

describe("checkConsensus", () => {
  it("notes an average target moved by 5% or more, or a new rating", async () => {
    const { store, e } = await setup();
    await store.saveConsensus("US.MDB", 5, 461, NOW);
    world({ average: 455 });
    expect(await checkConsensus(e, store, NOW)).toEqual([]);
    vi.restoreAllMocks();
    await store.saveConsensus("US.MDB", 5, 461, NOW);
    world({ average: 420 });
    const [note] = await checkConsensus(e, store, NOW);
    expect(note).toContain("US.MDB analysts' average target moved from 461.00 to 420.00 (-8.9%)");
    expect(await store.consensusFor("US.MDB")).toEqual({ rating: 5, average: 420 });
  });

  it("only records the first reading", async () => {
    const { store, e } = await setup();
    world({ average: 420 });
    expect(await checkConsensus(e, store, NOW)).toEqual([]);
    expect(await store.consensusFor("US.MDB")).toEqual({ rating: 5, average: 420 });
  });
});
