import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../src/moomoo/research";
import { scorePlan, updateOutcomes } from "../src/outcomes";
import type { Plan, PlanFields } from "../src/plans";
import { Store } from "../src/store";
import { mockFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const CREATED = new Date("2026-06-01T15:00:00Z");
const buy: PlanFields = {
  action: "BUY", entryLow: 95, entryHigh: 105, partialTp: null, tp: 130, sl: 90,
  confidence: "medium", holdingMonths: 6, trimPct: null, reasoning: "r",
};
const plan = (kw: Partial<Plan> = {}): Plan => ({ ...buy, id: 1, code: "US.X", state: "OPEN", createdAt: CREATED.toISOString(), fired: [], ...kw });
const day = (date: string, low: number, high: number, close: number): Candle => ({ date, open: close, high, low, close, volume: 1 });

/** Daily candles from 2026-06-01 for ``n`` days, closing at ``close(i)`` with a 1-point range. */
const series = (n: number, close: (i: number) => number) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
  return day(d, close(i) - 1, close(i) + 1, close(i));
});

describe("scorePlan", () => {
  it("counts a stop touched before the target", () => {
    const candles = [day("2026-06-02", 89, 101, 95), day("2026-06-03", 100, 131, 130)];
    expect(scorePlan(plan(), candles, "2026-06-10").firstHit).toBe("SL");
  });

  it("counts a same-day touch of both as the stop", () =>
    expect(scorePlan(plan(), [day("2026-06-02", 89, 131, 100)], "2026-06-10").firstHit).toBe("SL"));

  it("measures returns from the entry midpoint, and leaves future weeks empty", () => {
    const out = scorePlan(plan(), series(120, () => 110), "2026-09-28"); // 17 weeks on
    expect(out.firstHit).toBeNull();
    expect(out.returns[0]).toBeCloseTo(0.1, 6); // 110 / 100 - 1
    expect(out.returns[1]).toBeCloseTo(0.1, 6);
    expect(out.returns[2]).toBeNull();
  });

  it("uses the first close without an entry zone", () =>
    expect(scorePlan(plan({ entryLow: null, entryHigh: null }), series(40, (i) => (i === 0 ? 100 : 120)), "2026-07-10").returns[0])
      .toBeCloseTo(0.2, 6));
});

describe("updateOutcomes", () => {
  async function setup() {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r");
    await store.setSetting("moomoo_access", "tok");
    await store.setSetting("moomoo_access_until", "2026-12-31T00:00:00Z");
    return store;
  }
  const kline = (candles: Candle[]) => mockFetch((url) => url.includes("/history-kline")
    ? Response.json({ ret_code: 0, ret_msg: "success", data: { kline_list: candles.map((c) => ({ ...c, date: Number(c.date.replace(/-/g, "")) })) } })
    : undefined);

  it("skips plans younger than 4 weeks or without a target", async () => {
    const store = await setup();
    await store.savePlan("US.X", buy, "OPEN", new Date("2026-06-20T15:00:00Z"));
    await store.savePlan("US.Y", { ...buy, tp: null }, "HELD", CREATED);
    const calls = kline(series(60, () => 110));
    expect(await updateOutcomes(env, store, new Date("2026-07-10T15:00:00Z"))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("fills later returns on a later run and keeps the first hit", async () => {
    const store = await setup();
    const id = await store.savePlan("US.X", buy, "OPEN", CREATED);
    const candles = series(130, (i) => (i === 3 ? 89.5 : 110)); // the stop is touched on day 4
    kline(candles.slice(0, 40));
    const [first] = await updateOutcomes(env, store, new Date("2026-07-10T15:00:00Z"));
    expect(first).toMatchObject({ planId: id, firstHit: "SL", ret12w: null });
    vi.restoreAllMocks();
    kline(candles);
    const [second] = await updateOutcomes(env, store, new Date("2026-08-31T15:00:00Z"));
    expect(second).toMatchObject({ planId: id, firstHit: "SL" });
    expect(second!.ret12w).toBeCloseTo(0.1, 6);
    expect(await store.scorecard()).toMatchObject({ scored: 1, stops: 1, targets: 0 });
  });
});
