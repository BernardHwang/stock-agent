import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataSheet } from "../src/datasheet";
import type { Env } from "../src/env";
import { runAnalysis, type Step } from "../src/pipeline";
import { Store } from "../src/store";
import { mockFetch, sentTexts, telegramOk } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-24T15:00:00Z");
const DEEP = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const QUICK = "@cf/meta/llama-4-scout-17b-16e-instruct";
const sheet: DataSheet = {
  code: "US.MDB", price: 316, session: "regular", asOf: NOW.toISOString(), hasNews: true,
  text: "# Verified data sheet: US.MDB\n## Price\nCurrent: 316.00",
};
const goodPlan = JSON.stringify({
  action: "BUY", entry_low: 300, entry_high: 315, partial_tp: 360, tp: 390, sl: 270,
  confidence: "medium", holding_months: 6, reasoning: "Accumulate near support.",
});
const badPlan = JSON.stringify({
  action: "BUY", entry_low: 420, entry_high: 450, partial_tp: null, tp: 580, sl: 380,
  confidence: "high", holding_months: 6, reasoning: "Stale levels.",
});

/** A fake Workers AI: the portfolio manager (asked for JSON) gets ``pm``; every other role a short report. */
function fakeAi(pm: string) {
  const calls: { model: string; system: string; user: string }[] = [];
  const ai = {
    run: vi.fn(async (model: string, input: { messages: { content: string }[] }) => {
      const [system, user] = input.messages.map((m) => m.content);
      calls.push({ model, system: system!, user: user! });
      return { response: system!.includes("Answer with ONLY this JSON object") ? pm : `report ${calls.length}`, usage: {} };
    }),
  };
  return { ai: ai as unknown as Ai, calls };
}

/** A Workflows-like step: results are cached by name, as a resumed instance would replay them. */
function fakeStep(cache = new Map<string, unknown>()): Step {
  return {
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (!cache.has(name)) cache.set(name, await fn());
      return cache.get(name) as T;
    },
  };
}

async function setup(pm: string) {
  const store = new Store(env.DB);
  await store.enqueue("US.MDB", "chat", 0, NOW);
  const item = (await store.nextQueued())!;
  await store.setQueueStatus(item.id, "running");
  const { ai, calls } = fakeAi(pm);
  const e = { ...env, AI: ai, QUICK_MODEL: QUICK, DEEP_MODEL: DEEP } as Env;
  const deps = { sheet: async () => sheet, token: async () => "tok" };
  return { store, item, calls, e, deps };
}

describe("runAnalysis", () => {
  it("runs 11 roles in order and saves an OPEN plan for an unheld buy", async () => {
    const { store, item, calls, e, deps } = await setup(goodPlan);
    const sent = mockFetch(telegramOk);
    await runAnalysis(fakeStep(), e, store, item, NOW, deps);

    expect(calls).toHaveLength(11);
    const deep = calls.map((c, i) => (c.model === DEEP ? i : -1)).filter((i) => i >= 0);
    expect(deep).toEqual([5, 6, 10]); // research manager, trader, portfolio manager
    for (const c of calls) expect(c.user).toContain("Verified data sheet");

    expect((await store.planFor("US.MDB"))).toMatchObject({ state: "OPEN", entryLow: 300, sl: 270 });
    expect((await store.loadReport("US.MDB"))!.text).toContain("Research manager");
    expect((await store.queueItem(item.id))!.status).toBe("done");
    const texts = sentTexts(sent);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Buy zone");
  });

  it("does not repeat AI calls or messages when a run is replayed", async () => {
    const { store, item, calls, e, deps } = await setup(goodPlan);
    const sent = mockFetch(telegramOk);
    const cache = new Map<string, unknown>();
    await runAnalysis(fakeStep(cache), e, store, item, NOW, deps);
    await runAnalysis(fakeStep(cache), e, store, item, NOW, deps);
    expect(calls).toHaveLength(11);
    expect(sentTexts(sent)).toHaveLength(1);
  });

  it("saves the report but no plan when the levels fail the checks twice", async () => {
    const { store, item, calls, e, deps } = await setup(badPlan);
    const sent = mockFetch(telegramOk);
    await runAnalysis(fakeStep(), e, store, item, NOW, deps);
    expect(calls).toHaveLength(12); // one retry for the portfolio manager
    expect(await store.planFor("US.MDB")).toBeNull();
    expect(await store.loadReport("US.MDB")).not.toBeNull();
    expect(sentTexts(sent)[0]).toContain("buy zone");
  });

  it("tells the portfolio manager when the investor already holds the stock", async () => {
    const { store, item, calls, e, deps } = await setup(goodPlan);
    await store.savePositions([{ code: "US.MDB", name: "MongoDB", qty: 7, avgCost: 358.09 }], NOW);
    mockFetch(telegramOk);
    await runAnalysis(fakeStep(), e, store, item, NOW, deps);
    expect(calls.at(-1)!.user).toContain("holds 7 shares at an average cost of 358.09");
    expect(await store.planFor("US.MDB")).toMatchObject({ state: "HELD", action: "HOLD" });
  });
});
