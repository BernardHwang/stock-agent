import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotFacts } from "../src/market";
import { earnings, incomeGrowth } from "../src/moomoo/research";
import { mockFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const ok = (data: unknown) => new Response(JSON.stringify({ ret_code: 0, ret_msg: "success", data }));

describe("snapshotFacts", () => {
  it("computes the day, pre-market and week changes from one snapshot", () => {
    const facts = snapshotFacts([{
      code: "US.SPY", name: "SPDR S&P 500", last_price: 722.29, prev_close_price: 689.81, pre_price: 725, pre_change_rate: 0.38,
      close_price_5day: 700, highest52weeks_price: 730, close_price_60day: 650, close_price_250day: 600, pe_ttm_ratio: 25,
    }]);
    const spy = facts.get("US.SPY")!;
    expect(spy.changePct).toBeCloseTo(4.71, 2);
    expect(spy.preChangePct).toBe(0.38);
    expect(spy.weekChangePct).toBeCloseTo(3.184, 2);
    expect(spy).toMatchObject({ name: "SPDR S&P 500", last: 722.29, prevClose: 689.81, prePrice: 725, high52: 730, close60: 650, close250: 600, pe: 25 });
  });

  it("gives null, not NaN, for missing fields", () => {
    const f = snapshotFacts([{ code: "US.X", last_price: 10 }]).get("US.X")!;
    expect(f).toMatchObject({ changePct: null, preChangePct: null, weekChangePct: null, prevClose: null, pe: null, name: "US.X" });
  });

  it("works out the pre-market change when moomoo gives only the price", () =>
    expect(snapshotFacts([{ code: "US.X", last_price: 100, pre_price: 103.2 }]).get("US.X")!.preChangePct).toBeCloseTo(3.2, 5));
});

describe("research additions", () => {
  it("reads revenue and net income growth from the newest income statement", async () => {
    const body = JSON.stringify((await import("./fixtures/income.json")).default);
    const calls = mockFetch(() => new Response(body));
    expect(await incomeGrowth("tok", "US.MDB")).toEqual({ revenue: 30.5, netIncome: 187.0 });
    expect(calls[0]!.url).toContain("statement_type=1");
  });

  it("reads the earnings calendar in spans of at most 7 days", async () => {
    const calls = mockFetch((url) => ok({ items: url.includes("begin_date=2026-11-24")
      ? [{ code: "US.MDB", earnings_date: "2026-11-25", pub_type: "AFTER", eps_predict: "0.8" }] : [{ code: "US.X", earnings_date: "2026-12-02" }] }));
    const out = await earnings("tok", "2026-11-24", "2026-12-03");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("end_date=2026-11-30");
    expect(calls[1]!.url).toContain("begin_date=2026-12-01");
    expect(calls[1]!.url).toContain("end_date=2026-12-03");
    expect(out).toEqual([
      { code: "US.MDB", date: "2026-11-25", when: "AFTER", epsEstimate: 0.8, published: false },
      { code: "US.X", date: "2026-12-02", when: null, epsEstimate: null, published: false },
    ]);
  });
});
