import type { Plan, PlanFields, PlanState } from "./plans";

export interface Position {
  code: string;
  name: string;
  qty: number;
  /** Average price paid per share, when moomoo reports one. */
  avgCost: number | null;
}

interface PlanRow {
  id: number;
  code: string;
  state: PlanState;
  action: Plan["action"];
  entry_low: number | null;
  entry_high: number | null;
  partial_tp: number | null;
  tp: number | null;
  sl: number | null;
  confidence: Plan["confidence"];
  holding_months: number;
  reasoning: string;
  created_at: string;
  fired: string;
}

const toPlan = (r: PlanRow): Plan => ({
  id: r.id, code: r.code, state: r.state, action: r.action, entryLow: r.entry_low, entryHigh: r.entry_high,
  partialTp: r.partial_tp, tp: r.tp, sl: r.sl, confidence: r.confidence, holdingMonths: r.holding_months,
  reasoning: r.reasoning, createdAt: r.created_at, fired: JSON.parse(r.fired) as string[],
});

export class Store {
  constructor(private readonly db: D1Database) {}

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ? row.value : null;
  }

  /** An empty string unsets the key. */
  async setSetting(key: string, value: string): Promise<void> {
    await this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, value).run();
  }

  /** True only the first time ``key`` is seen: guards once-a-day and once-per-event work. */
  async markOnce(key: string, at: Date): Promise<boolean> {
    const res = await this.db.prepare("INSERT OR IGNORE INTO once_keys (key, at) VALUES (?, ?)").bind(key, at.toISOString()).run();
    return res.meta.changes > 0;
  }

  async savePositions(positions: Position[], at: Date): Promise<void> {
    const insert = this.db.prepare("INSERT INTO positions (code, name, qty, avg_cost, updated_at) VALUES (?, ?, ?, ?, ?)");
    await this.db.batch([
      this.db.prepare("DELETE FROM positions"),
      ...positions.map((p) => insert.bind(p.code, p.name, p.qty, p.avgCost, at.toISOString())),
    ]);
  }

  async lastPositions(): Promise<Position[]> {
    const { results } = await this.db.prepare("SELECT code, name, qty, avg_cost FROM positions ORDER BY code")
      .all<{ code: string; name: string; qty: number; avg_cost: number | null }>();
    return results.map((r) => ({ code: r.code, name: r.name, qty: r.qty, avgCost: r.avg_cost }));
  }

  async activePlans(): Promise<Plan[]> {
    const { results } = await this.db.prepare("SELECT * FROM plans WHERE state IN ('OPEN', 'TRIGGERED', 'HELD') ORDER BY id")
      .all<PlanRow>();
    return results.map(toPlan);
  }

  async savePlan(code: string, f: PlanFields, state: PlanState, at: Date): Promise<number> {
    const row = await this.db.prepare(
      `INSERT INTO plans (code, state, action, entry_low, entry_high, partial_tp, tp, sl, confidence, holding_months,
         reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(code, state, f.action, f.entryLow, f.entryHigh, f.partialTp, f.tp, f.sl, f.confidence, f.holdingMonths,
      f.reasoning, at.toISOString()).first<{ id: number }>();
    return row!.id;
  }

  async updatePlan(p: Plan): Promise<void> {
    await this.db.prepare(
      `UPDATE plans SET state = ?, action = ?, entry_low = ?, entry_high = ?, partial_tp = ?, tp = ?, sl = ?,
         confidence = ?, holding_months = ?, reasoning = ?, fired = ? WHERE id = ?`,
    ).bind(p.state, p.action, p.entryLow, p.entryHigh, p.partialTp, p.tp, p.sl, p.confidence, p.holdingMonths,
      p.reasoning, JSON.stringify(p.fired), p.id).run();
  }
}
