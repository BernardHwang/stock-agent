import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTicker, runTool, TOOLS } from "../src/chat/tools";
import type { Env } from "../src/env";
import type { PlanFields } from "../src/plans";
import { Store } from "../src/store";
import { mockFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-24T03:00:00Z");
const e = { ...env, MAX_RUNS_PER_DAY: "2" } as Env;
const call = async (store: Store, name: string, args: Record<string, unknown> = {}) =>
  JSON.parse(await runTool(e, store, name, args, NOW));
const hold: PlanFields = {
  action: "HOLD", entryLow: null, entryHigh: null, partialTp: null, tp: 400, sl: 280,
  confidence: "medium", holdingMonths: 6, trimPct: null, reasoning: "Keep holding.",
};


/** moomoo connected, with a snapshot that knows US.MDB and US.NVDA only. */
async function connected(store: Store) {
  await store.setSetting("moomoo_refresh", "r");
  await store.setSetting("moomoo_access", "tok");
  await store.setSetting("moomoo_access_until", "2026-12-31T00:00:00Z");
  return mockFetch((url, init) => {
    if (!url.endsWith("/quote/snapshot")) return undefined;
    const codes = (JSON.parse(String(init.body)) as { code_list: string[] }).code_list;
    const known = codes.filter((c) => c === "US.MDB" || c === "US.NVDA");
    return Response.json({ ret_code: 0, data: { snapshot_list: known.map((code) => ({ code, last_price: 100 })) } });
  });
}

describe("normalizeTicker", () => {
  it("accepts US tickers in any common form", () => {
    for (const t of ["mdb", "MDB", " US.MDB ", "us.mdb"]) expect(normalizeTicker(t)).toBe("US.MDB");
    expect(normalizeTicker("BRK.B")).toBe("US.BRK.B");
  });
  it("refuses other markets and junk", () => {
    for (const t of ["0700.HK", "HK.00700", "", "a b"]) expect(normalizeTicker(t)).toBeNull();
  });
});

describe("chat tools", () => {
  it("describes every tool for function calling", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["get_holdings", "get_quote", "get_plan", "list_plans", "get_news", "queue_analysis"]);
    for (const t of TOOLS) expect(t.parameters.type).toBe("object");
  });

  it("queues an analysis once and says when it will run", async () => {
    const store = new Store(env.DB);
    await connected(store);
    const first = await call(store, "queue_analysis", { ticker: "mdb" });
    expect(first).toMatchObject({ code: "US.MDB", status: "queued", position: 1, runs_left_today: 2 });
    expect((await call(store, "queue_analysis", { ticker: "MDB" })).status).toBe("already queued");
    expect(await store.pendingItems()).toHaveLength(1);
  });

  it("explains a wait at the daily limit", async () => {
    const store = new Store(env.DB);
    await connected(store);
    await store.recordRun("US.X", NOW);
    await store.recordRun("US.Y", NOW);
    const out = await call(store, "queue_analysis", { ticker: "MDB" });
    expect(out.note).toContain("tomorrow");
  });

  it("refuses a ticker moomoo doesn't know, without queuing it", async () => {
    const store = new Store(env.DB);
    await connected(store);
    expect((await call(store, "queue_analysis", { ticker: "XYZQ" })).error).toContain("couldn't find US.XYZQ");
    expect(await store.pendingItems()).toEqual([]);
  });

  it("refuses to queue while moomoo isn't connected", async () => {
    mockFetch(() => undefined);
    expect((await call(new Store(env.DB), "queue_analysis", { ticker: "MDB" })).error).toContain("/moomoo");
  });

  it("refuses a non-US ticker", async () => {
    expect(await call(new Store(env.DB), "queue_analysis", { ticker: "0700.HK" })).toEqual({ error: "Only US stocks for now." });
  });

  it("says when there is no plan yet", async () => {
    const out = await call(new Store(env.DB), "get_plan", { ticker: "NVDA" });
    expect(out.plan).toBeNull();
    expect(out.hint).toContain("queue_analysis");
  });

  it("returns a plan with an excerpt of its report", async () => {
    const store = new Store(env.DB);
    await store.savePlan("US.MDB", hold, "HELD", NOW);
    await store.saveReport("US.MDB", "R".repeat(3000), 316, NOW);
    const out = await call(store, "get_plan", { ticker: "MDB" });
    expect(out.plan).toMatchObject({ action: "HOLD", sl: 280, state: "HELD" });
    expect(out.report.length).toBeLessThanOrEqual(1500);
  });

  it("lists holdings with their plans", async () => {
    const store = new Store(env.DB);
    await store.savePositions([{ code: "US.MDB", name: "MongoDB", qty: 7, avgCost: 358.09 }], NOW);
    await store.savePlan("US.MDB", hold, "HELD", NOW);
    mockFetch(() => undefined); // moomoo not connected in this test: no live prices
    const out = await call(store, "get_holdings");
    expect(out.positions[0]).toMatchObject({ code: "US.MDB", qty: 7, avg_cost: 358.09, plan: { action: "HOLD", sl: 280 } });
  });

  it("lists active plans", async () => {
    const store = new Store(env.DB);
    await store.savePlan("US.MDB", hold, "HELD", NOW);
    expect((await call(store, "list_plans")).plans).toEqual([expect.objectContaining({ code: "US.MDB", sl: 280 })]);
  });

  it("answers unknown tools and bad arguments with an error, never a throw", async () => {
    expect((await call(new Store(env.DB), "place_trade")).error).toContain("unknown tool");
    expect((await call(new Store(env.DB), "get_quote", {})).error).toBeDefined();
  });

  it("keeps every answer within 3,000 characters", async () => {
    const store = new Store(env.DB);
    await store.savePositions(Array.from({ length: 80 }, (_, i) => ({ code: `US.T${i}`, name: "x".repeat(30), qty: 1, avgCost: 1 })), NOW);
    mockFetch(() => undefined);
    expect((await runTool(e, store, "get_holdings", {}, NOW)).length).toBeLessThanOrEqual(3000);
  });
});
