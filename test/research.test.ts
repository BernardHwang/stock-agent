import { afterEach, describe, expect, it, vi } from "vitest";
import { candles, consensus, earningsHistory, keyIndicators, nextEarnings, peValuation, shortInterest } from "../src/moomoo/research";
import { mockFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const fixture = async (name: string) => JSON.stringify((await import(`./fixtures/${name}.json`)).default);
const answer = (body: string) => mockFetch(() => new Response(body));

describe("moomoo research data", () => {
  it("reads daily candles oldest first with ISO dates", async () => {
    const calls = answer(await fixture("kline"));
    const out = await candles("tok", "US.MDB", "2026-11-24");
    expect(out.map((c) => [c.date, c.close])).toEqual([["2026-11-20", 285.9], ["2026-11-23", 312.69]]);
    expect(calls[0]!.url).toContain("/api/v1.0/quote/US.MDB/history-kline?");
    expect(calls[0]!.url).toContain("end=2026-11-24");
  });

  it("reads the analyst consensus", async () => {
    answer(await fixture("analyst"));
    expect(await consensus("tok", "US.MDB")).toMatchObject({ average: 461.39, total: 31, rating: 5, buyPct: 90.323 });
  });

  it("reads the newest key indicators", async () => {
    answer(await fixture("indicators"));
    const out = await keyIndicators("tok", "US.MDB");
    expect(out[0]).toEqual({ name: "Gross Margin", value: 72.6877, yoy: 0.5 });
    expect(out.find((i) => i.name === "FCF to Net Income")!.yoy).toBeNull();
  });

  it("reads the PE and its historical percentile", async () => {
    answer(await fixture("valuation"));
    expect(await peValuation("tok", "US.MDB")).toEqual({ current: 440.408, forward: 524.776, percentile: 78.8 });
  });

  it("reads short interest", async () => {
    answer(await fixture("short"));
    expect(await shortInterest("tok", "US.MDB")).toEqual({ percent: 3.452, daysToCover: 1.75, asOf: "2026-10-30" });
  });

  it("returns empty when moomoo has no data, and throws on an error code", async () => {
    answer('{"ret_code":0,"ret_msg":"success","data":{"items":[]}}');
    expect(await shortInterest("tok", "US.X")).toBeNull();
    answer('{"ret_code":-3,"ret_msg":"missing required parameter: end"}');
    await expect(candles("tok", "US.MDB", "2026-11-24")).rejects.toThrow("missing required parameter");
  });

  it("reads the last earnings date and the average earnings-day move", async () => {
    const day = (d: string, offset: number) => ({ pub_trading_day_str: d, day_offset: offset, period_text: "x" });
    const calls = answer(JSON.stringify({ ret_code: 0, ret_msg: "success", data: {
      records: [day("2026-06-02", -1), day("2026-06-02", 0), day("2026-09-01", -1), day("2026-09-01", 0)],
      overview_recent_period_count: 8, overview_avg_earnings_day_change_pct: 1.1529,
    } }));
    expect(await earningsHistory("tok", "US.MDB")).toEqual({ lastDate: "2026-09-01", avgMovePct: 1.1529, periods: 8 });
    expect(calls[0]!.url).toContain("/api/v1.0/quote/US.MDB/financials/earnings-price-move?");
  });

  it("finds the next unpublished earnings date in the market calendar, week by week", async () => {
    const calls = mockFetch((url) => {
      const items = url.includes("begin_date=2026-12-01")
        ? [{ code: "US.MDB", earnings_date: "2026-12-03", pub_type: "AFTER", published: false }]
        : url.includes("begin_date=2026-11-24")
          ? [{ code: "US.MDB", earnings_date: "2026-11-24", published: true }, { code: "US.X", earnings_date: "2026-11-25" }]
          : [];
      return new Response(JSON.stringify({ ret_code: 0, ret_msg: "success", data: { items } }));
    });
    expect(await nextEarnings("tok", "US.MDB", "2026-11-24")).toEqual({ date: "2026-12-03", session: "AFTER" });
    expect(calls).toHaveLength(4);
    expect(calls[0]!.url).toContain("/api/v1.0/quote/earnings-calendar?");
    expect(calls[0]!.url).toContain("end_date=2026-11-30");
    expect(calls[0]!.url).toContain("market=US");
  });

  it("finds no next earnings date when the calendar doesn't list the stock", async () => {
    answer(JSON.stringify({ ret_code: 0, ret_msg: "success", data: { items: [] } }));
    expect(await nextEarnings("tok", "US.MDB", "2026-11-24")).toBeNull();
  });
});
