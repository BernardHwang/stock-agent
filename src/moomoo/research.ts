/** moomoo research data for the analysis data sheet (read-only GETs). */
import { apiGet } from "./api";

export interface Candle {
  date: string; // YYYY-MM-DD, New York trading date
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type Obj = Record<string, unknown>;
/** moomoo sends numbers as numbers or numeric strings; anything else is "no data". */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Up to 370 daily candles ending at ``end`` (YYYY-MM-DD), forward-adjusted, oldest first. */
export async function candles(token: string, code: string, end: string): Promise<Candle[]> {
  const query = new URLSearchParams({ ktype: "2", autype: "1", num: "370", end });
  const d = (await apiGet(token, `/api/v1.0/quote/${encodeURIComponent(code)}/history-kline?${query}`)) as Obj | null;
  const rows = (d?.kline_list as Obj[] | undefined) ?? [];
  return rows
    .map((r) => {
      const ymd = String(r.date ?? "");
      return {
        date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
        open: num(r.open) ?? 0, high: num(r.high) ?? 0, low: num(r.low) ?? 0, close: num(r.close) ?? 0,
        volume: num(r.volume) ?? 0,
      };
    })
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date) && c.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface Consensus {
  rating: number | null; // 1-5
  total: number;
  average: number | null;
  highest: number | null;
  lowest: number | null;
  buyPct: number | null; // strong buy + buy
  holdPct: number | null;
  sellPct: number | null;
}

export async function consensus(token: string, code: string): Promise<Consensus | null> {
  const d = (await apiGet(token, `/api/v1.0/quote/${encodeURIComponent(code)}/research/analyst-consensus`)) as Obj | null;
  const total = num(d?.total) ?? 0;
  if (!d || !total) return null;
  const strong = num(d.strong_buy);
  const buy = num(d.buy);
  return {
    rating: num(d.rating), total, average: num(d.average), highest: num(d.highest), lowest: num(d.lowest),
    buyPct: strong === null && buy === null ? null : (strong ?? 0) + (buy ?? 0), holdPct: num(d.hold), sellPct: num(d.sell),
  };
}

export interface Indicator {
  name: string;
  value: number;
  yoy: number | null;
}

/** Key financial indicators (margins, returns, liquidity) from the newest report. */
export async function keyIndicators(token: string, code: string): Promise<Indicator[]> {
  const query = new URLSearchParams({ statement_type: "4", limit: "1" });
  const d = (await apiGet(token, `/api/v1.0/quote/${encodeURIComponent(code)}/financials/statements?${query}`)) as Obj | null;
  const report = ((d?.report_list as Obj[] | undefined) ?? [])[0];
  return ((report?.item_list as Obj[] | undefined) ?? [])
    .map((i) => ({ name: String(i.display_name ?? ""), value: num(i.data), yoy: num(i.yoy) }))
    .filter((i): i is Indicator => Boolean(i.name) && i.value !== null);
}

/** Current and forward PE, and where today's PE sits in its own history (0-100). */
export async function peValuation(token: string, code: string): Promise<{ current: number | null; forward: number | null; percentile: number | null } | null> {
  const d = (await apiGet(token, `/api/v1.0/quote/${encodeURIComponent(code)}/valuation/detail?valuation_type=1`)) as Obj | null;
  const t = d?.trend as Obj | undefined;
  if (!t) return null;
  return { current: num(t.current_value), forward: num(t.forward_value), percentile: num(t.valuation_percentile) };
}

export async function shortInterest(token: string, code: string): Promise<{ percent: number; daysToCover: number | null; asOf: string } | null> {
  const d = (await apiGet(token, `/api/v1.0/quote/${encodeURIComponent(code)}/short/interest?count=1`)) as Obj | null;
  const item = ((d?.items as Obj[] | undefined) ?? [])[0];
  const percent = num(item?.short_percent);
  if (!item || percent === null) return null;
  return { percent, daysToCover: num(item.days_to_cover), asOf: String(item.timestamp_str ?? "") };
}
