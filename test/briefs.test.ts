import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { morningBrief, preOpenNote } from "../src/briefs";
import type { Env } from "../src/env";
import type { PlanFields } from "../src/plans";
import { Store } from "../src/store";
import { mockFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const DAYS = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30", "2026-12-01"];
const TUE_BRIEF = new Date("2026-11-25T00:00:00Z"); // Wed 08:00 MYT, after Tuesday's session
const hold: PlanFields = {
  action: "HOLD", entryLow: null, entryHigh: null, partialTp: null, tp: 400, sl: 300,
  confidence: "medium", holdingMonths: 6, trimPct: null, reasoning: "r",
};

async function setup(days = DAYS) {
  const store = new Store(env.DB);
  await store.setSetting("moomoo_refresh", "r");
  await store.setSetting("moomoo_access", "tok");
  await store.setSetting("moomoo_access_until", "2026-12-31T00:00:00Z");
  await store.setSetting("trading_days", JSON.stringify(days));
  await store.savePositions([{ code: "US.MDB", name: "MongoDB", qty: 7, avgCost: 358 }], TUE_BRIEF);
  await store.savePlan("US.MDB", hold, "HELD", TUE_BRIEF);
  const prompts: string[] = [];
  const ai = { run: vi.fn(async (_m: string, input: { messages: { content: string }[] }) => {
    prompts.push(input.messages.at(-1)!.content);
    return { response: "Watch MDB into earnings.", usage: {} };
  }) };
  return { store, e: { ...env, AI: ai as unknown as Ai } as Env, ai, prompts };
}

const ok = (data: unknown) => Response.json({ ret_code: 0, ret_msg: "success", data });
const row = (code: string, last: number, prev: number, extra: Record<string, unknown> = {}) =>
  ({ code, name: code === "US.MDB" ? "MongoDB" : code, last_price: last, prev_close_price: prev, ...extra });

function market(opts: { snapshotDown?: boolean; pre?: number } = {}) {
  return mockFetch((url) => {
    if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true });
    if (url.startsWith("https://query1.finance.yahoo.com/")) {
      return Response.json({ news: [
        { title: "MongoDB beats estimates", publisher: "Reuters", providerPublishTime: Date.parse("2026-11-24T21:00:00Z") / 1000 },
        { title: "Central Garden & Pet earnings", publisher: "Zacks", providerPublishTime: Date.parse("2026-11-24T21:00:00Z") / 1000 },
      ] });
    }
    if (url.endsWith("/quote/snapshot")) {
      if (opts.snapshotDown) return new Response("down", { status: 503 });
      return ok({ snapshot_list: [row("US.SPY", 690, 686.57), row("US.QQQ", 600, 603), row("US.DIA", 450, 450),
        row("US.MDB", 316, 312.25, opts.pre === undefined ? {} : { pre_price: opts.pre })] });
    }
    if (url.includes("/earnings-calendar")) return ok({ items: [{ code: "US.MDB", earnings_date: "2026-11-26", pub_type: "AFTER" }] });
    return undefined;
  });
}

describe("morningBrief", () => {
  it("lists each holding with P/L against its cost and the distance to its stop and target", async () => {
    const { store, e, ai } = await setup();
    market();
    const text = (await morningBrief(e, store, TUE_BRIEF))!;
    expect(text).toContain("Morning brief (2026-11-24)");
    expect(text).toContain("S&P 500 +0.50%");
    expect(text).toContain("Nasdaq 100 -0.50%");
    expect(text).toContain("US.MDB 316.00 (+1.20%) · P/L -11.7% · stop 300.00 (-5.1%) · target 400.00 (+26.6%)");
    expect(text).toContain("US.MDB 2026-11-26 (after the close)");
    expect(text).toContain("MongoDB beats estimates");
    expect(text).not.toContain("Central Garden");
    expect(text).toContain("What matters today: Watch MDB into earnings.");
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("runs after a trading day only", async () => {
    const { store, e } = await setup();
    market();
    expect(await morningBrief(e, store, new Date("2026-11-28T00:00:00Z"))).not.toBeNull(); // Sat 08:00 MYT, after Friday
    expect(await morningBrief(e, store, new Date("2026-11-29T00:00:00Z"))).toBeNull(); // Sun 08:00 MYT, after Saturday
  });

  it("skips the morning after a holiday", async () => {
    const { store, e } = await setup(DAYS.filter((d) => d !== "2026-11-30"));
    market();
    expect(await morningBrief(e, store, new Date("2026-12-01T00:00:00Z"))).toBeNull(); // Tue 08:00 MYT after a Monday holiday
  });

  it("says index moves are unavailable when the snapshot fails", async () => {
    const { store, e } = await setup();
    market({ snapshotDown: true });
    const text = (await morningBrief(e, store, TUE_BRIEF))!;
    expect(text).toContain("Index moves unavailable");
    expect(text).toContain("US.MDB: price unavailable");
  });

  it("makes no AI call at 8,600 neurons", async () => {
    const { store, e, ai } = await setup();
    await store.setSetting("neurons:2026-11-25", "8600");
    market();
    const text = (await morningBrief(e, store, TUE_BRIEF))!;
    expect(ai.run).not.toHaveBeenCalled();
    expect(text).not.toContain("What matters today");
  });

  it("reminds to sign in again when moomoo expires within 3 days", async () => {
    const { store, e } = await setup();
    await store.setSetting("moomoo_until", "2026-11-27T00:00:00Z");
    market();
    expect(await morningBrief(e, store, TUE_BRIEF)).toContain("moomoo sign-in expires");
  });
});

describe("preOpenNote", () => {
  const TUE_PRE = new Date("2026-11-24T13:00:00Z"); // 21:00 MYT, 08:00 EST

  it("lists pre-market movers and today's earnings among holdings", async () => {
    const { store, e } = await setup();
    market({ pre: 326.11 }); // +3.2% against the last close of 316
    const text = (await preOpenNote(e, store, TUE_PRE))!;
    expect(text).toContain("US.MDB pre-market 326.11 (+3.20%)");
  });

  it("stays quiet on a holiday or when nothing moved", async () => {
    const { store, e } = await setup();
    market({ pre: 326.11 });
    expect(await preOpenNote(e, store, new Date("2026-11-26T13:00:00Z"))).toBeNull(); // Thanksgiving
    vi.restoreAllMocks();
    market();
    expect(await preOpenNote(e, store, TUE_PRE)).toBeNull();
  });
});
