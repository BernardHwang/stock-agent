import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { learn, recentLessons } from "../src/lessons";
import type { PlanFields } from "../src/plans";
import { Store } from "../src/store";

const NOW = new Date("2026-08-31T15:00:00Z");
const buy: PlanFields = {
  action: "BUY", entryLow: 95, entryHigh: 105, partialTp: null, tp: 130, sl: 90,
  confidence: "high", holdingMonths: 6, trimPct: null, reasoning: "Breakout on earnings momentum.",
};

async function setup() {
  const store = new Store(env.DB);
  const id = await store.savePlan("US.X", buy, "CLOSED", new Date("2026-06-01T15:00:00Z"));
  await store.saveReport("US.X", "# Analysis\n\n## Decision\nBUY: Breakout on earnings momentum.", 100, new Date("2026-06-01T15:00:00Z"));
  const prompts: string[] = [];
  const ai = { run: vi.fn(async (_m: string, input: { messages: { content: string }[] }) => {
    prompts.push(input.messages.at(-1)!.content);
    return { response: "A high-confidence breakout call failed within days; wait for a retest next time.", usage: {} };
  }) };
  return { store, plan: (await store.getPlan(id))!, e: { ...env, AI: ai as unknown as Ai } as Env, ai, prompts };
}

describe("learn", () => {
  it("writes one lesson when a plan's stop was hit first", async () => {
    const { store, plan, e, ai, prompts } = await setup();
    const outcome = { planId: plan.id, firstHit: "SL" as const, ret4w: -0.12, ret12w: null, ret26w: null };
    expect(await learn(e, store, outcome, plan, NOW)).toContain("wait for a retest");
    expect(await learn(e, store, outcome, plan, NOW)).toBeNull();
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain("BUY: Breakout on earnings momentum.");
    expect(prompts[0]).toContain("stop-loss was hit first");
    expect(await recentLessons(store, "US.X")).toEqual(["A high-confidence breakout call failed within days; wait for a retest next time."]);
  });

  it("waits for a decisive outcome", async () => {
    const { store, plan, e, ai } = await setup();
    expect(await learn(e, store, { planId: plan.id, firstHit: null, ret4w: 0.05, ret12w: null, ret26w: null }, plan, NOW)).toBeNull();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("skips at 8,600 neurons", async () => {
    const { store, plan, e, ai } = await setup();
    await store.setSetting("neurons:2026-08-31", "8600");
    expect(await learn(e, store, { planId: plan.id, firstHit: "TP", ret4w: 0.3, ret12w: null, ret26w: null }, plan, NOW)).toBeNull();
    expect(ai.run).not.toHaveBeenCalled();
  });
});
