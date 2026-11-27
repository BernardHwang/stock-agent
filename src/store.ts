import type { Plan, PlanFields, PlanState } from "./plans";
import { localDayBounds } from "./time";

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
  trim_pct: number | null;
  reasoning: string;
  created_at: string;
  fired: string;
}

const toPlan = (r: PlanRow): Plan => ({
  id: r.id, code: r.code, state: r.state, action: r.action, entryLow: r.entry_low, entryHigh: r.entry_high,
  partialTp: r.partial_tp, tp: r.tp, sl: r.sl, confidence: r.confidence, holdingMonths: r.holding_months,
  trimPct: r.trim_pct, reasoning: r.reasoning, createdAt: r.created_at, fired: JSON.parse(r.fired) as string[],
});

export interface Outcome {
  planId: number;
  firstHit: "SL" | "TP" | null;
  ret4w: number | null;
  ret12w: number | null;
  ret26w: number | null;
}

interface OutcomeRow {
  plan_id: number;
  first_hit: string | null;
  ret_4w: number | null;
  ret_12w: number | null;
  ret_26w: number | null;
}

export type QueueStatus = "pending" | "running" | "done" | "failed";
export type ChatRole = "user" | "bot" | "alert";

export interface QueueItem {
  id: number;
  code: string;
  reason: string;
  priority: number;
  status: QueueStatus;
  createdAt: string;
}

interface QueueRow {
  id: number;
  code: string;
  reason: string;
  priority: number;
  status: QueueStatus;
  created_at: string;
}

const toQueueItem = (r: QueueRow): QueueItem => ({
  id: r.id, code: r.code, reason: r.reason, priority: r.priority, status: r.status, createdAt: r.created_at,
});

export interface Report {
  code: string;
  at: string;
  price: number | null;
  text: string;
}

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
         trim_pct, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(code, state, f.action, f.entryLow, f.entryHigh, f.partialTp, f.tp, f.sl, f.confidence, f.holdingMonths,
      f.trimPct, f.reasoning, at.toISOString()).first<{ id: number }>();
    return row!.id;
  }

  async getPlan(id: number): Promise<Plan | null> {
    const row = await this.db.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first<PlanRow>();
    return row ? toPlan(row) : null;
  }

  async planFor(code: string): Promise<Plan | null> {
    const row = await this.db.prepare(
      "SELECT * FROM plans WHERE code = ? AND state IN ('OPEN', 'TRIGGERED', 'HELD') ORDER BY id DESC LIMIT 1",
    ).bind(code).first<PlanRow>();
    return row ? toPlan(row) : null;
  }

  // Analysis queue

  /** False when the code already has a pending or running item. */
  async enqueue(code: string, reason: string, priority: number, at: Date): Promise<boolean> {
    const busy = await this.db.prepare("SELECT 1 FROM queue WHERE code = ? AND status IN ('pending', 'running') LIMIT 1")
      .bind(code).first();
    if (busy) return false;
    await this.db.prepare("INSERT INTO queue (code, reason, priority, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .bind(code, reason, priority, at.toISOString()).run();
    return true;
  }

  async nextQueued(): Promise<QueueItem | null> {
    const row = await this.db.prepare(
      "SELECT * FROM queue WHERE status = 'pending' ORDER BY priority, created_at, id LIMIT 1",
    ).first<QueueRow>();
    return row ? toQueueItem(row) : null;
  }

  async queueItem(id: number): Promise<QueueItem | null> {
    const row = await this.db.prepare("SELECT * FROM queue WHERE id = ?").bind(id).first<QueueRow>();
    return row ? toQueueItem(row) : null;
  }

  async pendingItems(): Promise<QueueItem[]> {
    const { results } = await this.db.prepare(
      "SELECT * FROM queue WHERE status = 'pending' ORDER BY priority, created_at, id",
    ).all<QueueRow>();
    return results.map(toQueueItem);
  }

  async setQueueStatus(id: number, status: QueueStatus): Promise<void> {
    await this.db.prepare("UPDATE queue SET status = ? WHERE id = ?").bind(status, id).run();
  }

  /** Change the status only if it is still ``from``; true when it changed (guards against late, stale updates). */
  async setQueueStatusIf(id: number, from: QueueStatus, to: QueueStatus): Promise<boolean> {
    const res = await this.db.prepare("UPDATE queue SET status = ? WHERE id = ? AND status = ?").bind(to, id, from).run();
    return res.meta.changes > 0;
  }

  async runningItems(): Promise<QueueItem[]> {
    const { results } = await this.db.prepare("SELECT * FROM queue WHERE status = 'running' ORDER BY id").all<QueueRow>();
    return results.map(toQueueItem);
  }

  async isRunning(): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 FROM queue WHERE status = 'running' LIMIT 1").first());
  }

  // Runs (the daily analysis budget)

  async recordRun(code: string, at: Date): Promise<void> {
    await this.db.prepare("INSERT INTO runs (code, at) VALUES (?, ?)").bind(code, at.toISOString()).run();
  }

  async forgetRun(code: string, at: Date): Promise<void> {
    await this.db.prepare("DELETE FROM runs WHERE rowid = (SELECT rowid FROM runs WHERE code = ? AND at = ? LIMIT 1)")
      .bind(code, at.toISOString()).run();
  }

  /** Runs during the local day ``day`` (YYYY-MM-DD) in ``tz``. */
  async countRunsOn(day: string, tz: string): Promise<number> {
    const [start, end] = localDayBounds(day, tz);
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE at >= ? AND at < ?").bind(start, end)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  // Chat log (context for the chat, and the daily chat limit)

  async logChat(role: ChatRole, text: string, at: Date): Promise<void> {
    await this.db.prepare("INSERT INTO chat_log (role, text, at) VALUES (?, ?, ?)").bind(role, text, at.toISOString()).run();
  }

  /** The last ``limit`` entries, oldest first. */
  async recentChat(limit: number): Promise<{ role: ChatRole; text: string }[]> {
    const { results } = await this.db.prepare("SELECT role, text FROM chat_log ORDER BY id DESC LIMIT ?").bind(limit)
      .all<{ role: ChatRole; text: string }>();
    return results.reverse();
  }

  /** Messages the owner sent during the local day ``day`` in ``tz``. */
  async countChatOn(day: string, tz: string): Promise<number> {
    const [start, end] = localDayBounds(day, tz);
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM chat_log WHERE role = 'user' AND at >= ? AND at < ?")
      .bind(start, end).first<{ n: number }>();
    return row?.n ?? 0;
  }

  // Reports (the latest full analysis per code)

  async saveReport(code: string, text: string, price: number | null, at: Date): Promise<void> {
    await this.db.prepare(
      "INSERT INTO reports (code, at, price, text) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(code) DO UPDATE SET at = excluded.at, price = excluded.price, text = excluded.text",
    ).bind(code, at.toISOString(), price, text).run();
  }

  async loadReport(code: string): Promise<Report | null> {
    return this.db.prepare("SELECT code, at, price, text FROM reports WHERE code = ?").bind(code).first<Report>();
  }

  async updatePlan(p: Plan): Promise<void> {
    await this.db.prepare(
      `UPDATE plans SET state = ?, action = ?, entry_low = ?, entry_high = ?, partial_tp = ?, tp = ?, sl = ?,
         confidence = ?, holding_months = ?, trim_pct = ?, reasoning = ?, fired = ? WHERE id = ?`,
    ).bind(p.state, p.action, p.entryLow, p.entryHigh, p.partialTp, p.tp, p.sl, p.confidence, p.holdingMonths,
      p.trimPct, p.reasoning, JSON.stringify(p.fired), p.id).run();
  }

  // Analyst consensus last seen per stock (event notes)
  async consensusFor(code: string): Promise<{ rating: number | null; average: number | null } | null> {
    return this.db.prepare("SELECT rating, average FROM consensus WHERE code = ?").bind(code)
      .first<{ rating: number | null; average: number | null }>();
  }

  async saveConsensus(code: string, rating: number | null, average: number | null, at: Date): Promise<void> {
    await this.db.prepare("INSERT OR REPLACE INTO consensus (code, rating, average, at) VALUES (?, ?, ?, ?)")
      .bind(code, rating, average, at.toISOString()).run();
  }

  // Plan outcomes
  async allPlans(): Promise<Plan[]> {
    const { results } = await this.db.prepare("SELECT * FROM plans ORDER BY id").all<PlanRow>();
    return results.map(toPlan);
  }

  async outcome(planId: number): Promise<Outcome | null> {
    const r = await this.db.prepare("SELECT * FROM outcomes WHERE plan_id = ?").bind(planId).first<OutcomeRow>();
    return r ? { planId: r.plan_id, firstHit: r.first_hit as Outcome["firstHit"], ret4w: r.ret_4w, ret12w: r.ret_12w, ret26w: r.ret_26w } : null;
  }

  async saveOutcome(o: Outcome, at: Date): Promise<void> {
    await this.db.prepare(
      "INSERT OR REPLACE INTO outcomes (plan_id, first_hit, ret_4w, ret_12w, ret_26w, at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(o.planId, o.firstHit, o.ret4w, o.ret12w, o.ret26w, at.toISOString()).run();
  }

  /** Plans scored, stops and targets hit first, and the average 12-week return (a fraction) where known. */
  async scorecard(): Promise<{ scored: number; stops: number; targets: number; avg12w: number | null }> {
    const r = await this.db.prepare(
      `SELECT COUNT(*) AS scored, SUM(first_hit = 'SL') AS stops, SUM(first_hit = 'TP') AS targets, AVG(ret_12w) AS avg12w
         FROM outcomes`,
    ).first<{ scored: number; stops: number | null; targets: number | null; avg12w: number | null }>();
    return { scored: r?.scored ?? 0, stops: r?.stops ?? 0, targets: r?.targets ?? 0, avg12w: r?.avg12w ?? null };
  }
}
