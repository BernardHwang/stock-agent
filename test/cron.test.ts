import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMinute } from "../src/cron";
import type { PlanFields } from "../src/plans";
import { Store } from "../src/store";
import { type Call, mockFetch, sentTexts, telegramOk } from "./helpers";

afterEach(() => vi.restoreAllMocks());

// Tue 2026-11-24 10:00 EST (regular session); trading days around it, Thanksgiving (26th) missing.
const TUE_OPEN = new Date("2026-11-24T15:00:00Z");
const DAYS = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30"];
const hold: PlanFields = {
  action: "HOLD", entryLow: null, entryHigh: null, partialTp: null, tp: 400, sl: 300,
  confidence: "medium", holdingMonths: 6, reasoning: "r",
};
const at = (iso: string) => new Date(iso);
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

async function connectedStore(): Promise<Store> {
  const store = new Store(env.DB);
  await store.setSetting("moomoo_refresh", "r");
  await store.setSetting("moomoo_access", "tok");
  await store.setSetting("moomoo_access_until", "2026-12-31T00:00:00Z");
  await store.savePlan("US.MDB", hold, "HELD", TUE_OPEN);
  await store.savePositions([{ code: "US.MDB", name: "MongoDB", qty: 7, avgCost: 358 }], TUE_OPEN);
  return store;
}

/** moomoo answers: trading days, a snapshot with ``price`` for US.MDB (null -> code missing), positions. */
function moomoo(price: () => number | null, status = () => 200) {
  return (url: string) => {
    if (telegramOk(url)) return telegramOk(url);
    if (!url.startsWith("https://webapi.moomoo.com")) return undefined;
    if (status() !== 200) return new Response("down", { status: status() });
    if (url.includes("/quote/trading-days")) return Response.json({ s: "ok", d: DAYS.map((time) => ({ time })) });
    if (url.endsWith("/quote/snapshot")) {
      const p = price();
      return Response.json({ s: "ok", d: p === null ? [] : [{ code: "US.MDB", last_price: p, pre_price: 0, after_price: 0, overnight_price: 0 }] });
    }
    if (url.endsWith("/authorized_trd_accs")) return Response.json({ s: "ok", d: { accounts: [{ account_id: 7 }] } });
    if (url.includes("/7/positions")) return Response.json({ s: "ok", d: [{ code: "US.MDB", qty: 7, cost_price: 358 }] });
    return undefined;
  };
}
const snapshotCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/quote/snapshot")).length;
const positionCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/authorized_trd_accs")).length;

describe("runMinute", () => {
  it("does nothing when moomoo isn't connected", async () => {
    const calls = mockFetch(moomoo(() => 299));
    await runMinute(env, new Store(env.DB), TUE_OPEN);
    expect(calls).toEqual([]);
  });

  it("warns once when a holding trades at or below its stop", async () => {
    const store = await connectedStore();
    let price = 299;
    const calls = mockFetch(moomoo(() => price));
    await runMinute(env, store, TUE_OPEN);
    price = 298;
    await runMinute(env, store, plusMin(TUE_OPEN, 1));
    const warnings = sentTexts(calls).filter((t) => t.includes("Stop-loss"));
    expect(warnings).toEqual(["⚠️ Stop-loss: US.MDB at 299.00 (stop 300.00, regular trading). Review this position."]);
  });

  it("stays quiet above the stop", async () => {
    const store = await connectedStore();
    const calls = mockFetch(moomoo(() => 316));
    await runMinute(env, store, TUE_OPEN);
    expect(sentTexts(calls)).toEqual([]);
    expect(snapshotCalls(calls)).toBe(1);
  });

  it("makes no quote call on a weekend or a holiday", async () => {
    const store = await connectedStore();
    const calls = mockFetch(moomoo(() => 299));
    await runMinute(env, store, at("2026-11-28T15:00:00Z")); // Saturday
    await runMinute(env, store, at("2026-11-26T15:00:00Z")); // Thanksgiving
    expect(snapshotCalls(calls)).toBe(0);
  });

  it("checks overnight in 24h mode but not in regular mode", async () => {
    const store = await connectedStore();
    const calls = mockFetch(moomoo(() => 316));
    await runMinute(env, store, at("2026-11-24T06:00:00Z")); // 01:00 EST
    expect(snapshotCalls(calls)).toBe(1);
    await runMinute({ ...env, PRICE_HOURS: "regular" }, store, at("2026-11-24T06:01:00Z"));
    expect(snapshotCalls(calls)).toBe(1);
  });

  it("makes no stop-loss decision without a price", async () => {
    const store = await connectedStore();
    const calls = mockFetch(moomoo(() => null));
    await runMinute(env, store, TUE_OPEN);
    expect(sentTexts(calls)).toEqual([]);
  });

  it("reports moomoo down once after 3 failures, and recovery once", async () => {
    const store = await connectedStore();
    await store.setSetting("trading_days", JSON.stringify(DAYS));
    await store.markOnce("tdays:2026-11-24", TUE_OPEN);
    let status = 503;
    const calls = mockFetch(moomoo(() => 316, () => status));
    for (let i = 0; i < 5; i++) await runMinute(env, store, plusMin(TUE_OPEN, i + 1));
    status = 200;
    await runMinute(env, store, plusMin(TUE_OPEN, 6));
    await runMinute(env, store, plusMin(TUE_OPEN, 7));
    expect(sentTexts(calls)).toEqual(["moomoo is unreachable; stop-loss checks are paused.", "moomoo is reachable again."]);
  });

  it("syncs holdings every 15 minutes in the regular session", async () => {
    const store = await connectedStore();
    const calls = mockFetch(moomoo(() => 316));
    await runMinute(env, store, at("2026-11-24T15:15:00Z"));
    await runMinute(env, store, at("2026-11-24T15:16:00Z"));
    expect(positionCalls(calls)).toBe(1);
  });

  it("syncs holdings once a day at 07:55 local time", async () => {
    const store = await connectedStore();
    const calls = mockFetch(moomoo(() => 316));
    await runMinute(env, store, at("2026-11-23T23:55:00Z")); // 07:55 MYT Tue = 18:55 EST Mon
    await runMinute(env, store, at("2026-11-23T23:56:00Z"));
    expect(positionCalls(calls)).toBe(1);
  });
});

describe("runMinute robustness", () => {
  it("counts an empty trading calendar as a failure instead of pausing silently", async () => {
    const store = await connectedStore();
    const calls = mockFetch((url) => telegramOk(url) ??
      (url.includes("/quote/trading-days") ? Response.json({ s: "ok", d: { unexpected: "shape" } }) : undefined));
    for (let i = 0; i < 3; i++) await runMinute(env, store, plusMin(TUE_OPEN, i));
    expect(sentTexts(calls)).toEqual(["moomoo is unreachable; stop-loss checks are paused."]);
    expect(await store.getSetting("trading_days_on")).toBeNull();
  });

  it("counts a regular-session snapshot with no prices as a failure", async () => {
    const store = await connectedStore();
    mockFetch(moomoo(() => null));
    await runMinute(env, store, TUE_OPEN);
    expect(await store.getSetting("moomoo_failures")).toBe("1");
  });

  it("does not claim recovery on a minute that never reached moomoo", async () => {
    const store = await connectedStore();
    await store.setSetting("trading_days", JSON.stringify(DAYS));
    await store.setSetting("trading_days_on", "2026-11-25");
    const calls = mockFetch((url) => telegramOk(url) ??
      (url.endsWith("/quote/snapshot") ? new Response("down", { status: 503 }) : undefined));
    for (let i = 0; i < 3; i++) await runMinute(env, store, at(`2026-11-25T15:0${i}:00Z`)); // Wed, in session
    await runMinute(env, store, at("2026-11-26T01:30:00Z")); // Wed 20:30 EST, before Thanksgiving: idle
    expect(sentTexts(calls)).toEqual(["moomoo is unreachable; stop-loss checks are paused."]);
  });

  it("retries a stop-loss warning that Telegram did not accept", async () => {
    const store = await connectedStore();
    let telegramUp = false;
    const calls = mockFetch((url) => url.startsWith("https://api.telegram.org/")
      ? (telegramUp ? Response.json({ ok: true }) : new Response("err", { status: 500 }))
      : moomoo(() => 299)(url));
    await runMinute(env, store, TUE_OPEN);
    expect((await store.activePlans())[0]!.fired).toEqual([]);
    expect(await store.getSetting("moomoo_failures")).toBeNull(); // a Telegram problem is not a moomoo failure
    telegramUp = true;
    await runMinute(env, store, plusMin(TUE_OPEN, 1));
    expect((await store.activePlans())[0]!.fired).toEqual(["SL"]);
    expect(calls.filter((c) => c.url.includes("/sendMessage"))).toHaveLength(2);
  });

  it("sends several triggered stops as one message", async () => {
    const store = await connectedStore();
    await store.savePlan("US.NVDA", { ...hold, sl: 170 }, "HELD", TUE_OPEN);
    const calls = mockFetch((url) => telegramOk(url) ?? (url.endsWith("/quote/snapshot")
      ? Response.json({ s: "ok", d: [{ code: "US.MDB", last_price: 299 }, { code: "US.NVDA", last_price: 160 }] })
      : moomoo(() => 299)(url)));
    await runMinute(env, store, plusMin(TUE_OPEN, 1)); // 10:01, not a holdings-sync minute
    const texts = sentTexts(calls);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("US.MDB");
    expect(texts[0]).toContain("US.NVDA");
  });
});
