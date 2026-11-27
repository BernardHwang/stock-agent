/** Facts from moomoo snapshot rows, computed in code: day, pre-market and week changes, trend proxies. */

export interface Facts {
  code: string;
  name: string;
  last: number | null;
  prevClose: number | null;
  changePct: number | null;
  prePrice: number | null;
  preChangePct: number | null;
  weekChangePct: number | null;
  high52: number | null;
  close60: number | null;
  close250: number | null;
  pe: number | null;
}

const positive = (v: unknown): number | null => {
  const n = v === null || v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const number = (v: unknown): number | null => {
  const n = v === null || v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};
const pctChange = (to: number | null, from: number | null) => (to === null || from === null ? null : ((to - from) / from) * 100);

export function snapshotFacts(rows: Record<string, unknown>[]): Map<string, Facts> {
  const out = new Map<string, Facts>();
  for (const r of rows) {
    if (typeof r.code !== "string") continue;
    const last = positive(r.last_price);
    const prevClose = positive(r.prev_close_price);
    const prePrice = positive(r.pre_price);
    out.set(r.code, {
      code: r.code, name: typeof r.name === "string" && r.name ? r.name : r.code, last, prevClose,
      changePct: pctChange(last, prevClose), prePrice,
      // Before the open, last_price is still the previous close.
      preChangePct: number(r.pre_change_rate) ?? pctChange(prePrice, last),
      weekChangePct: pctChange(last, positive(r.close_price_5day)),
      high52: positive(r.highest52weeks_price), close60: positive(r.close_price_60day), close250: positive(r.close_price_250day),
      pe: number(r.pe_ttm_ratio),
    });
  }
  return out;
}
