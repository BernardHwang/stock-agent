import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNIVERSE } from "../src/config";
import type { Env } from "../src/env";
import { sundayReview } from "../src/review";
import { Store } from "../src/store";
import { mockFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-29T02:00:00Z"); // Sunday 10:00 MYT
const [A, B] = UNIVERSE as [string, string];
const ok = (data: unknown) => Response.json({ ret_code: 0, ret_msg: "success", data });

async function setup() {
  const store = new Store(env.DB);
  await store.setSetting("moomoo_refresh", "r");
  await store.setSetting("moomoo_access", "tok");
  await store.setSetting("moomoo_access_until", "2026-12-31T00:00:00Z");
  await store.savePositions([{ code: "US.MDB", name: "MongoDB", qty: 7, avgCost: 358 }], NOW);
  const ai = { run: vi.fn(async () => ({ response: `${A}: Strong growth on a pullback.\n${B}: Uptrend with rising margins.`, usage: {} })) };
  return { store, e: { ...env, AI: ai as unknown as Ai } as Env, ai };
}

function world(screenerDown = false) {
  return mockFetch((url, init) => {
    if (url.endsWith("/quote/snapshot")) {
      const codes = (JSON.parse(String(init.body)) as { code_list: string[] }).code_list;
      if (codes.includes(A)) {
        if (screenerDown) return new Response("down", { status: 500 });
        return ok({ snapshot_list: [A, B].map((code) => ({ code, name: `${code} Inc`, last_price: 85, highest52weeks_price: 100, pe_ttm_ratio: 30 })) });
      }
      return ok({ snapshot_list: [
        { code: "US.SPY", last_price: 707, close_price_5day: 700 },
        { code: "US.QQQ", last_price: 594, close_price_5day: 600 },
        { code: "US.MDB", name: "MongoDB", last_price: 316, close_price_5day: 310 },
      ] });
    }
    if (url.includes("/financials/statements")) {
      return ok({ report_list: [{ item_list: [
        { display_name: "Total Operating Revenue", yoy: url.includes(encodeURIComponent(A)) ? 40 : 20 },
        { display_name: "Net Income to Common Stockholders", yoy: 30 },
      ] }] });
    }
    return undefined;
  });
}

describe("sundayReview", () => {
  it("reports the week, the scorecard and the screener ideas with one AI call", async () => {
    const { store, e, ai } = await setup();
    world();
    const text = await sundayReview(e, store, NOW);
    expect(text).toContain("Weekly review");
    expect(text).toContain("S&P 500 +1.00%");
    expect(text).toContain("Nasdaq 100 -1.00%");
    expect(text).toContain("US.MDB 316.00, week +1.94%, P/L -11.7%");
    expect(text).toContain("not enough history yet");
    expect(text).toContain(`${A} ${A} Inc 85.00 (+40% revenue, +30% earnings, pullback): Strong growth on a pullback.`);
    expect(text).toContain(`${B} ${B} Inc 85.00 (+20% revenue, +30% earnings, pullback): Uptrend with rising margins.`);
    expect(text.trim().endsWith('Say "analyze <ticker>" for a full analysis.')).toBe(true);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("queues the top idea for a full analysis, once", async () => {
    const { store, e } = await setup();
    world();
    expect(await sundayReview(e, store, NOW)).toContain(`I've queued a full analysis of ${A}`);
    await sundayReview(e, store, NOW);
    expect((await store.pendingItems()).map((i) => [i.code, i.reason])).toEqual([[A, "screener"]]);
  });

  it("still reviews the week when the screener fails", async () => {
    const { store, e } = await setup();
    world(true);
    const text = await sundayReview(e, store, NOW);
    expect(text).toContain("Screener ideas are unavailable this week.");
    expect(text).toContain("US.MDB 316.00");
  });

  it("shows the numbers only at 8,600 neurons", async () => {
    const { store, e, ai } = await setup();
    await store.setSetting("neurons:2026-11-29", "8600");
    world();
    const text = await sundayReview(e, store, NOW);
    expect(ai.run).not.toHaveBeenCalled();
    expect(text).toContain(`${A} ${A} Inc 85.00 (+40% revenue, +30% earnings, pullback)`);
  });

  it("shows the scorecard once plans are scored", async () => {
    const { store, e } = await setup();
    await store.saveOutcome({ planId: 1, firstHit: "TP", ret4w: 0.1, ret12w: 0.2, ret26w: null }, NOW);
    await store.saveOutcome({ planId: 2, firstHit: "SL", ret4w: -0.1, ret12w: 0, ret26w: null }, NOW);
    world();
    expect(await sundayReview(e, store, NOW)).toContain("2 plans scored: 1 hit the target first, 1 the stop; average 12-week return +10.0%");
  });
});
