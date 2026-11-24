import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDataSheet } from "../src/datasheet";
import { headlines } from "../src/news";
import { mockFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-24T15:00:00Z"); // Tue 10:00 New York, regular session
const fixture = async (name: string) => JSON.stringify((await import(`./fixtures/${name}.json`)).default);
const ok = (data: unknown) => new Response(JSON.stringify({ ret_code: 0, ret_msg: "success", data }));

// 30 candles closing 100..129 (oldest first once sorted); SMA 20 = mean(110..129) = 119.5.
const kline = {
  kline_list: Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 1 + i));
    const ymd = Number(d.toISOString().slice(0, 10).replace(/-/g, ""));
    return { date: ymd, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 };
  }).reverse(),
};
const snapshot = {
  snapshot_list: [{
    code: "US.MDB", last_price: 312.69, prev_close_price: 285.9, pre_price: 0, after_price: 0, overnight_price: 0,
    highest52weeks_price: 473.1, lowest52weeks_price: 215.68, pe_ttm_ratio: 440.4, pb_ratio: 9.1,
    earning_per_share: -0.88, dividend_ratio_ttm: 0, total_market_val: 25190000000, beta: 1.75,
  }],
};
const yahoo = {
  news: [
    { title: "MongoDB beats estimates", publisher: "Reuters", providerPublishTime: 1795400000 },
    { title: "Cloud software rebounds", publisher: "Barron's", providerPublishTime: 1795300000 },
  ],
};

async function moomooAndYahoo(yahooAnswer: () => Response) {
  const [analyst, indicators, valuation, short] = await Promise.all(
    ["analyst", "indicators", "valuation", "short"].map(fixture));
  return mockFetch((url) => {
    if (url.startsWith("https://query1.finance.yahoo.com/")) return yahooAnswer();
    if (url.endsWith("/quote/snapshot")) return ok(snapshot);
    if (url.includes("/history-kline")) return ok(kline);
    if (url.includes("/analyst-consensus")) return new Response(analyst);
    if (url.includes("/financials/statements")) return new Response(indicators);
    if (url.includes("/valuation/detail")) return new Response(valuation);
    if (url.includes("/short/interest")) return new Response(short);
    return undefined;
  });
}

describe("headlines", () => {
  it("reads Yahoo's search news for the symbol", async () => {
    const calls = mockFetch(() => new Response(JSON.stringify(yahoo)));
    const out = await headlines("US.MDB");
    expect(out.map((h) => h.title)).toEqual(["MongoDB beats estimates", "Cloud software rebounds"]);
    expect(calls[0]!.url).toContain("q=MDB");
  });

  it("returns nothing instead of failing when Yahoo blocks the request", async () => {
    mockFetch(() => new Response("forbidden", { status: 403 }));
    expect(await headlines("US.MDB")).toEqual([]);
    mockFetch(() => { throw new TypeError("network"); });
    expect(await headlines("US.MDB")).toEqual([]);
  });
});

describe("buildDataSheet", () => {
  it("puts verified numbers from every source on the sheet", async () => {
    await moomooAndYahoo(() => new Response(JSON.stringify(yahoo)));
    const sheet = await buildDataSheet("tok", "US.MDB", NOW);
    expect(sheet.price).toBe(312.69);
    expect(sheet.hasNews).toBe(true);
    for (const part of ["## Price", "## Trend", "SMA 20: 119.50", "## Analysts", "461.39", "## Short interest", "3.45",
      "## Valuation & fundamentals", "Gross Margin", "## Headlines", "MongoDB beats estimates"]) {
      expect(sheet.text).toContain(part);
    }
  });

  it("works without headlines", async () => {
    await moomooAndYahoo(() => new Response("forbidden", { status: 403 }));
    const sheet = await buildDataSheet("tok", "US.MDB", NOW);
    expect(sheet.hasNews).toBe(false);
    expect(sheet.text).toContain("No headlines available.");
  });

  it("never exceeds 6,000 characters", async () => {
    const many = { news: Array.from({ length: 50 }, (_, i) => ({ title: "x".repeat(400) + i, publisher: "p", providerPublishTime: 1 })) };
    await moomooAndYahoo(() => new Response(JSON.stringify(many)));
    expect((await buildDataSheet("tok", "US.MDB", NOW)).text.length).toBeLessThanOrEqual(6000);
  });
});
