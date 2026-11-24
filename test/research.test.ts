import { afterEach, describe, expect, it, vi } from "vitest";
import { candles, consensus, keyIndicators, peValuation, shortInterest } from "../src/moomoo/research";
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
});
