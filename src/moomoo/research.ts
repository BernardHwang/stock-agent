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

/** The stock's industry name from moomoo's plates (null when it lists none). */
export async function industry(token: string, code: string): Promise<string | null> {
  const d = (await apiGet(token, `/api/v1.0/quote/${encodeURIComponent(code)}/owner-plate`)) as Obj | null;
  const plate = ((d?.sectors as Obj[] | undefined) ?? []).find((s) => s.plate_type === "INDUSTRY");
  return plate?.plate_name ? String(plate.plate_name) : null;
}

/** YYYY-MM-DD plus ``days`` calendar days. */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The most recent earnings day and the average earnings-day price change (%) over recent reports. */
export async function earningsHistory(token: string, code: string):
  Promise<{ lastDate: string | null; avgMovePct: number | null; periods: number | null } | null> {
  const query = new URLSearchParams({ count: "50", overview_count: "8" });
  const d = (await apiGet(token, `/api/v1.0/quote/${encodeURIComponent(code)}/financials/earnings-price-move?${query}`)) as Obj | null;
  if (!d) return null;
  // Rows are days around each report, in no documented order: the latest report day is the largest date.
  const dates = ((d.records as Obj[] | undefined) ?? []).map((r) => String(r.pub_trading_day_str ?? ""))
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
  return { lastDate: dates.at(-1) ?? null, avgMovePct: num(d.overview_avg_earnings_day_change_pct), periods: num(d.overview_recent_period_count) };
}

export interface EarningsItem {
  code: string;
  date: string; // YYYY-MM-DD
  when: string | null; // BEFORE / AFTER / REGULAR when moomoo says so
  epsEstimate: number | null;
  published: boolean;
}

/** The US earnings calendar from ``from`` to ``to`` (inclusive), read in spans of at most 7 days, largest companies first. */
export async function earnings(token: string, from: string, to: string): Promise<EarningsItem[]> {
  const spans: [string, string][] = [];
  for (let begin = from; begin <= to; begin = addDays(begin, 7)) {
    const end = addDays(begin, 6);
    spans.push([begin, end < to ? end : to]);
  }
  const lists = await Promise.all(spans.map(async ([begin, end]) => {
    const query = new URLSearchParams({ market: "US", begin_date: begin, end_date: end, sort_type: "MARKET_CAP", count: "500" });
    const d = (await apiGet(token, `/api/v1.0/quote/earnings-calendar?${query}`)) as Obj | null;
    return (d?.items as Obj[] | undefined) ?? [];
  }));
  return lists.flat()
    .filter((i) => typeof i.code === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(i.earnings_date ?? "")))
    .map((i) => ({
      code: String(i.code), date: String(i.earnings_date),
      when: typeof i.pub_type === "string" && /^[A-Z]+$/.test(i.pub_type) ? i.pub_type : null,
      epsEstimate: num(i.eps_predict), published: i.published === true,
    }));
}

export const EARNINGS_WEEKS = 4;

/** The next unpublished earnings date for ``code`` within EARNINGS_WEEKS from ``today``. */
export async function nextEarnings(token: string, code: string, today: string):
  Promise<{ date: string; session: string | null } | null> {
  const next = (await earnings(token, today, addDays(today, EARNINGS_WEEKS * 7 - 1)))
    .filter((i) => i.code === code && !i.published && i.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  return next ? { date: next.date, session: next.when } : null;
}

/** Year-on-year growth (%) of revenue and net income from the newest income statement. */
export async function incomeGrowth(token: string, code: string): Promise<{ revenue: number | null; netIncome: number | null }> {
  const query = new URLSearchParams({ statement_type: "1", limit: "1" });
  const d = (await apiGet(token, `/api/v1.0/quote/${encodeURIComponent(code)}/financials/statements?${query}`)) as Obj | null;
  const items = (((d?.report_list as Obj[] | undefined) ?? [])[0]?.item_list as Obj[] | undefined) ?? [];
  const yoy = (name: string) => num(items.find((i) => i.display_name === name)?.yoy);
  return { revenue: yoy("Total Operating Revenue"), netIncome: yoy("Net Income to Common Stockholders") };
}
