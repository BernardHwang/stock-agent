/** Technical indicators over oldest-first series. Each returns the latest value, or null with too little data. */
import type { Candle } from "./moomoo/research";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function sma(values: number[], n: number): number | null {
  return values.length < n ? null : mean(values.slice(-n));
}

/** EMA series seeded with the SMA of the first n values; index i of the result matches values[i + n - 1]. */
function emaSeries(values: number[], n: number): number[] {
  if (values.length < n) return [];
  const k = 2 / (n + 1);
  const out = [mean(values.slice(0, n))];
  for (let i = n; i < values.length; i++) out.push(out[out.length - 1]! + k * (values[i]! - out[out.length - 1]!));
  return out;
}

export function ema(values: number[], n: number): number | null {
  return emaSeries(values, n).at(-1) ?? null;
}

/** Wilder's RSI. */
export function rsi(closes: number[], n = 14): number | null {
  if (closes.length < n + 1) return null;
  const changes = closes.slice(1).map((c, i) => c - closes[i]!);
  let gain = mean(changes.slice(0, n).map((c) => Math.max(c, 0)));
  let loss = mean(changes.slice(0, n).map((c) => Math.max(-c, 0)));
  for (const c of changes.slice(n)) {
    gain = (gain * (n - 1) + Math.max(c, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-c, 0)) / n;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** MACD 12/26 with a 9-period signal line. */
export function macd(closes: number[]): { macd: number; signal: number; hist: number } | null {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  if (!slow.length) return null;
  const line = slow.map((s, i) => fast[i + 14]! - s); // fast starts 14 values earlier than slow
  const signal = emaSeries(line, 9);
  if (!signal.length) return null;
  const m = line.at(-1)!;
  const sig = signal.at(-1)!;
  return { macd: m, signal: sig, hist: m - sig };
}

export function bollinger(closes: number[], n = 20, width = 2): { mid: number; upper: number; lower: number } | null {
  if (closes.length < n) return null;
  const window = closes.slice(-n);
  const mid = mean(window);
  const sd = Math.sqrt(mean(window.map((c) => (c - mid) ** 2)));
  return { mid, upper: mid + width * sd, lower: mid - width * sd };
}

/** Wilder's average true range. */
export function atr(candles: Candle[], n = 14): number | null {
  if (candles.length < n + 1) return null;
  const tr = candles.slice(1).map((c, i) => {
    const prev = candles[i]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  let value = mean(tr.slice(0, n));
  for (const t of tr.slice(n)) value = (value * (n - 1) + t) / n;
  return value;
}
