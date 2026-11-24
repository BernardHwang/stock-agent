/** moomoo HTTP API, read-only: GETs, plus POST to the market-data (quote) endpoints only. */
import type { Position } from "../store";
import { MOOMOO_API } from "./oauth";

const QUOTE_PREFIX = "/api/v1.0/quote/";

async function parse(res: Response, path: string): Promise<unknown> {
  const name = path.split("?")[0];
  if (!res.ok) throw new Error(`moomoo ${name} failed: ${res.status}`);
  // Account numbers have more digits than a JavaScript number holds exactly, so long integers are kept as text.
  const body = JSON.parse((await res.text()).replace(/([:[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"')) as
    { s?: string; d?: unknown };
  if (body.s !== undefined && body.s !== "ok") throw new Error(`moomoo ${name} answered ${body.s}`);
  return body.d;
}

export async function apiGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(MOOMOO_API + path, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  return parse(res, path);
}

/** moomoo serves snapshots and quotes by POST; nothing outside the quote API may be posted to. */
export async function quotePost(token: string, path: string, body: object): Promise<unknown> {
  if (!path.startsWith(QUOTE_PREFIX)) throw new Error(`refusing to POST outside ${QUOTE_PREFIX}: ${path}`);
  const res = await fetch(MOOMOO_API + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parse(res, path);
}

interface PositionRow {
  code?: string;
  stock_name?: string;
  qty?: number | string;
  cost_price?: number | string;
  cost_price_valid?: boolean;
  security_type?: string;
}

/** Stock and ETF positions across every authorised account, merged per code at the average cost. */
export async function positions(token: string): Promise<{ positions: Position[]; skipped: string[] }> {
  const accounts = ((await apiGet(token, "/api/v1.0/accounts/authorized_trd_accs")) as { accounts?: { account_id: unknown }[] })
    ?.accounts ?? [];
  const merged = new Map<string, Position>();
  const skipped = new Set<string>();
  for (const account of accounts) {
    const id = encodeURIComponent(String(account.account_id));
    const rows = ((await apiGet(token, `/api/v1.0/accounts/${id}/positions`)) as PositionRow[] | null) ?? [];
    for (const row of rows) {
      const qty = Number(row.qty);
      if (!row.code || !Number.isFinite(qty) || qty <= 0) continue;
      const type = String(row.security_type ?? "STOCK").toUpperCase();
      if (!["STOCK", "ETF", "EQTY"].includes(type)) {
        skipped.add(row.code);
        continue;
      }
      // moomoo flags a cost it cannot vouch for, and reports 0 for shares received free.
      const reported = Number(row.cost_price);
      const cost = row.cost_price_valid !== false && Number.isFinite(reported) && reported > 0 ? reported : null;
      const have = merged.get(row.code);
      if (have) {
        have.avgCost = have.avgCost !== null && cost !== null ? (have.avgCost * have.qty + cost * qty) / (have.qty + qty) : null;
        have.qty += qty;
      } else {
        merged.set(row.code, { code: row.code, name: String(row.stock_name ?? row.code), qty, avgCost: cost });
      }
    }
  }
  return { positions: [...merged.values()], skipped: [...skipped] };
}
