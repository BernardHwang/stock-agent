import { describe, expect, it } from "vitest";
import { atr, bollinger, ema, macd, rsi, sma } from "../src/indicators";

const range = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
const candle = (close: number, spread = 2) => ({ date: "", open: close, high: close + spread / 2, low: close - spread / 2, close, volume: 1 });

describe("indicators", () => {
  it("sma averages the last n values", () => {
    expect(sma(range(10, (i) => i + 1), 5)).toBe(8);
  });

  it("ema of a constant series is the constant", () => {
    expect(ema(range(40, () => 7), 10)).toBeCloseTo(7, 10);
  });

  it("ema reacts to a jump faster than sma", () => {
    const jump = [...range(20, () => 0), ...range(5, () => 10)];
    expect(ema(jump, 10)!).toBeGreaterThan(sma(jump, 10)!);
  });

  it("rsi is 100 for a rising series and 0 for a falling one", () => {
    expect(rsi(range(30, (i) => i + 1))).toBe(100);
    expect(rsi(range(30, (i) => 100 - i))).toBe(0);
  });

  it("rsi of an even zigzag is near 50", () => {
    const value = rsi(range(60, (i) => (i % 2 ? 101 : 100)))!;
    expect(value).toBeGreaterThan(45);
    expect(value).toBeLessThan(55);
  });

  it("macd of a constant series is zero", () => {
    expect(macd(range(60, () => 5))).toEqual({ macd: 0, signal: 0, hist: 0 });
  });

  it("bollinger bands collapse on a constant series", () => {
    expect(bollinger(range(25, () => 3))).toEqual({ mid: 3, upper: 3, lower: 3 });
  });

  it("atr of identical candles equals their range", () => {
    expect(atr(range(30, () => candle(100, 2)))).toBeCloseTo(2, 10);
  });

  it("returns null with too little data", () => {
    expect(sma([1, 2], 5)).toBeNull();
    expect(ema([1, 2], 5)).toBeNull();
    expect(rsi([1, 2, 3])).toBeNull();
    expect(macd(range(20, (i) => i))).toBeNull();
    expect(bollinger([1, 2, 3])).toBeNull();
    expect(atr([candle(1)])).toBeNull();
  });
});
