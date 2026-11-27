import { afterEach, describe, expect, it, vi } from "vitest";
import { UNIVERSE } from "../src/config";
import { screen } from "../src/screener";
import { mockFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const ok = (data: unknown) => Response.json({ ret_code: 0, ret_msg: "success", data });
type Row = Record<string, unknown>;
/** A row 15% below its 52-week high, PE 30, flat over 60 days unless ``kw`` says otherwise. */
const row = (code: string, kw: Row = {}): Row => ({
  code, name: code, last_price: 85, highest52weeks_price: 100, pe_ttm_ratio: 30, close_price_60day: 85, close_price_250day: 90, ...kw,
});

function world(rows: Row[], growth: (code: string) => [number, number] | "error" = () => [20, 20]) {
  return mockFetch((url) => {
    if (url.endsWith("/quote/snapshot")) return ok({ snapshot_list: rows });
    if (url.includes("/financials/statements")) {
      const code = decodeURIComponent(url.split("/quote/")[1]!.split("/")[0]!);
      const g = growth(code);
      if (g === "error") return new Response("down", { status: 500 });
      return ok({ report_list: [{ item_list: [
        { display_name: "Total Operating Revenue", data: 1, yoy: g[0] },
        { display_name: "Net Income to Common Stockholders", data: 1, yoy: g[1] },
      ] }] });
    }
    return undefined;
  });
}
const statementCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("/financials/statements")).length;
const [A, B, C, D] = UNIVERSE as [string, string, string, string];

describe("screen", () => {
  it("drops a PE of 0 or above 60", async () => {
    world([row(A, { pe_ttm_ratio: 0 }), row(B, { pe_ttm_ratio: 61 }), row(C)]);
    expect((await screen("tok", new Set())).map((i) => i.code)).toEqual([C]);
  });

  it("keeps a 10-25% pullback, and a deeper one only in an uptrend", async () => {
    world([
      row(A), // 15% pullback
      row(B, { last_price: 70 }), // 30% below the high, no uptrend
      row(C, { last_price: 70, close_price_60day: 60, close_price_250day: 50 }), // 30% below, but in an uptrend
    ]);
    const out = await screen("tok", new Set());
    expect(out.map((i) => [i.code, i.reason]).sort()).toEqual([[A, "pullback"], [C, "uptrend"]].sort());
  });

  it("excludes held stocks", async () => {
    const calls = world([row(A), row(B)]);
    expect((await screen("tok", new Set([A]))).map((i) => i.code)).toEqual([B]);
    expect(JSON.parse(calls[0]!.body).code_list).not.toContain(A);
  });

  it("reads at most 15 income statements, for the strongest 60-day movers", async () => {
    const rows = UNIVERSE.slice(0, 20).map((code, i) => row(code, { close_price_60day: 85 - i }));
    const calls = world(rows);
    await screen("tok", new Set());
    expect(statementCalls(calls)).toBe(15);
    expect(calls.some((c) => c.url.includes(`/quote/${encodeURIComponent(UNIVERSE[19]!)}/financials`))).toBe(true); // strongest
    expect(calls.some((c) => c.url.includes(`/quote/${encodeURIComponent(UNIVERSE[0]!)}/financials`))).toBe(false); // weakest
  });

  it("drops a stock whose statement fails, or whose growth is below 10%", async () => {
    world([row(A), row(B), row(C)], (code) => (code === A ? "error" : code === B ? [5, 30] : [12, 15]));
    expect((await screen("tok", new Set())).map((i) => i.code)).toEqual([C]);
  });

  it("returns the top 3 by combined growth", async () => {
    const growth: Record<string, [number, number]> = { [A]: [20, 20], [B]: [50, 50], [C]: [30, 30], [D]: [11, 11] };
    world([row(A), row(B), row(C), row(D)], (code) => growth[code]!);
    const out = await screen("tok", new Set());
    expect(out.map((i) => i.code)).toEqual([B, C, A]);
    expect(out[0]).toMatchObject({ revenueGrowth: 50, earningsGrowth: 50, price: 85 });
  });

  it("throws when the snapshot fails", async () => {
    mockFetch(() => new Response("down", { status: 500 }));
    await expect(screen("tok", new Set())).rejects.toThrow();
  });
});
