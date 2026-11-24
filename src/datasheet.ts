/**
 * The verified data sheet: every number an analysis may use, fetched and computed in code before any AI call.
 * The AI reasons over this text; it never looks up or calculates prices itself.
 */
import { atr, bollinger, macd, rsi, sma } from "./indicators";
import { snapshotRows, sessionQuote } from "./moomoo/api";
import { candles, consensus, keyIndicators, peValuation, shortInterest } from "./moomoo/research";
import { headlines } from "./news";
import { localParts, type Session } from "./time";

export const SHEET_LIMIT = 6000;

export interface DataSheet {
  code: string;
  price: number;
  session: Session;
  asOf: string;
  text: string;
  hasNews: boolean;
}

const f = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? "n/a" : v.toFixed(digits));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${v.toFixed(2)}%`);
const big = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : `${(n / 1e6).toFixed(1)}M`;
};
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** A rejected optional source becomes null instead of failing the analysis. */
const optional = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    console.error("data sheet source failed", e instanceof Error ? e.name : typeof e);
    return null;
  }
};

export async function buildDataSheet(token: string, code: string, now: Date): Promise<DataSheet> {
  const today = localParts(now, "America/New_York").date;
  const [rows, history, analysts, indicators, pe, short, news] = await Promise.all([
    snapshotRows(token, [code]),
    candles(token, code, today),
    optional(consensus(token, code)),
    optional(keyIndicators(token, code)),
    optional(peValuation(token, code)),
    optional(shortInterest(token, code)),
    headlines(code),
  ]);
  const snap = rows.find((r) => r.code === code) ?? {};
  const live = sessionQuote(snap, now);
  const last = num(snap.last_price);
  const price = live?.price ?? last ?? history.at(-1)?.close;
  if (!price) throw new Error(`no price for ${code}`);
  const session = live?.session ?? "regular";

  const closes = history.map((c) => c.close);
  const prev = num(snap.prev_close_price) ?? history.at(-2)?.close ?? null;
  const m = macd(closes);
  const b = bollinger(closes);
  const lines = [
    `# Verified data sheet: ${code} (as of ${now.toISOString().slice(0, 16)}Z, ${session} session)`,
    "",
    "## Price",
    `Current: ${f(price)} (${session})` + (last && live && live.session !== "regular" ? `; last regular-session price ${f(last)}` : ""),
    `Previous close: ${f(prev)}; day change: ${prev ? pct(((price - prev) / prev) * 100) : "n/a"}`,
    `52-week range: ${f(num(snap.lowest52weeks_price))} - ${f(num(snap.highest52weeks_price))}`,
    "",
    "## Trend (daily, computed from moomoo candles)",
    `SMA 20: ${f(sma(closes, 20))}; SMA 50: ${f(sma(closes, 50))}; SMA 200: ${f(sma(closes, 200))}`,
    `RSI 14: ${f(rsi(closes), 1)}; ATR 14: ${f(atr(history))}`,
    `MACD: ${m ? `${f(m.macd)} / signal ${f(m.signal)} / histogram ${f(m.hist)}` : "n/a"}`,
    `Bollinger 20/2: ${b ? `${f(b.lower)} - ${f(b.upper)} (mid ${f(b.mid)})` : "n/a"}`,
    `Last 10 closes: ${history.slice(-10).map((c) => `${c.date.slice(5)} ${f(c.close)}`).join(", ") || "n/a"}`,
    "",
    "## Valuation & fundamentals",
    `Market cap: ${big(snap.total_market_val)}; PE (TTM): ${f(num(snap.pe_ttm_ratio))}; PB: ${f(num(snap.pb_ratio))}; ` +
      `EPS: ${f(num(snap.earning_per_share))}; dividend yield: ${pct(num(snap.dividend_ratio_ttm))}; beta: ${f(num(snap.beta))}`,
    pe ? `PE history: current ${f(pe.current)}, forward ${f(pe.forward)}, at the ${f(pe.percentile, 0)}th percentile of its own past` : "PE history: n/a",
    ...(indicators?.length
      ? indicators.slice(0, 14).map((i) => `${i.name}: ${f(i.value)}${i.yoy === null ? "" : ` (YoY ${pct(i.yoy)})`}`)
      : ["Key indicators: n/a"]),
    "",
    "## Analysts",
    analysts
      ? `${analysts.total} analysts; rating ${f(analysts.rating, 0)}/5; buy ${pct(analysts.buyPct)}, hold ${pct(analysts.holdPct)}, ` +
        `sell ${pct(analysts.sellPct)}; target average ${f(analysts.average)}, high ${f(analysts.highest)}, low ${f(analysts.lowest)}`
      : "No analyst consensus available.",
    "",
    "## Short interest",
    short ? `${pct(short.percent)} of float short; ${f(short.daysToCover)} days to cover (as of ${short.asOf})` : "n/a",
    "",
    "## Headlines",
    ...(news.length ? news.map((n) => `- ${n.at.slice(0, 10)} ${n.publisher}: ${n.title}`) : ["No headlines available."]),
  ];
  let text = lines.join("\n");
  if (text.length > SHEET_LIMIT) text = `${text.slice(0, SHEET_LIMIT - 1)}…`;
  return { code, price, session, asOf: now.toISOString(), text, hasNews: news.length > 0 };
}
