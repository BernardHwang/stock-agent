/** Tools the chat model can call. Read-only, except queuing an analysis. Answers are compact JSON text. */
import type { ToolDef } from "../ai";
import type { Env } from "../env";
import { quotes, snapshotRows } from "../moomoo/api";
import { accessToken } from "../moomoo/oauth";
import { headlines } from "../news";
import type { Plan } from "../plans";
import type { Store } from "../store";
import { localParts } from "../time";
import { analysisGate } from "../workflow";

const LIMIT = 3000;
const ticker = { type: "string", description: "US stock ticker, e.g. MDB or US.MDB" };

export const TOOLS: ToolDef[] = [
  { name: "get_holdings", description: "The owner's moomoo positions (quantity, average cost, live price when available) with each position's plan.",
    parameters: { type: "object", properties: {} } },
  { name: "get_quote", description: "Live price of one stock and which trading session it is from.",
    parameters: { type: "object", properties: { ticker }, required: ["ticker"] } },
  { name: "get_plan", description: "The active plan for one stock (action, buy zone, take-profit, stop-loss, reasoning) and an excerpt of its latest full analysis report.",
    parameters: { type: "object", properties: { ticker }, required: ["ticker"] } },
  { name: "list_plans", description: "All active plans, one line each.", parameters: { type: "object", properties: {} } },
  { name: "get_news", description: "Recent headlines about one stock.",
    parameters: { type: "object", properties: { ticker }, required: ["ticker"] } },
  { name: "queue_analysis", description: "Queue a full multi-analyst analysis of one stock that ends in a plan. It runs in the background (a few minutes) and its result is sent as a message. Use when the owner asks to analyse a stock or when a plan is missing or stale.",
    parameters: { type: "object", properties: { ticker }, required: ["ticker"] } },
];

/** "mdb", "MDB", "US.MDB" -> "US.MDB"; anything that isn't a US ticker -> null. */
export function normalizeTicker(input: string): string | null {
  const t = input.trim().toUpperCase();
  if (/^US\.[A-Z][A-Z.-]{0,9}$/.test(t)) return t;
  if (/^[A-Z][A-Z-]{0,5}(\.[A-Z])?$/.test(t)) return `US.${t}`;
  return null;
}

const planBrief = (p: Plan) => ({
  code: p.code, state: p.state, action: p.action, entry_low: p.entryLow, entry_high: p.entryHigh,
  partial_tp: p.partialTp, tp: p.tp, sl: p.sl, confidence: p.confidence, created: p.createdAt.slice(0, 10),
});

/** JSON within LIMIT characters; the named list is shortened (and marked truncated) when it doesn't fit. */
function fit(obj: Record<string, unknown>, listKey?: string): string {
  let text = JSON.stringify(obj);
  const list = listKey ? (obj[listKey] as unknown[]) : null;
  if (list) {
    for (let n = list.length - 1; text.length > LIMIT && n >= 0; n--) {
      text = JSON.stringify({ ...obj, [listKey!]: list.slice(0, n), truncated: true });
    }
  }
  return text.length > LIMIT ? `${text.slice(0, LIMIT - 1)}…` : text;
}

function code(args: Record<string, unknown>): string {
  const c = normalizeTicker(String(args.ticker ?? ""));
  if (!c) throw new ToolError(args.ticker ? "Only US stocks for now." : "ticker is required");
  return c;
}

class ToolError extends Error {}

async function queueAnalysis(env: Env, store: Store, c: string, now: Date): Promise<Record<string, unknown>> {
  // Check first, so a typo or a made-up ticker never costs one of the day's analyses.
  const token = await accessToken(env, store, now);
  if (!token) throw new ToolError("moomoo isn't connected, so I can't analyse yet. Connect it with /moomoo.");
  if (!(await snapshotRows(token, [c])).some((r) => r.code === c)) {
    throw new ToolError(`I couldn't find ${c} on moomoo. Check the ticker.`);
  }
  const added = await store.enqueue(c, "chat", 0, now);
  const pending = await store.pendingItems();
  const gate = await analysisGate(env, store, now);
  const running = (await store.runningItems())[0];
  let note = "It starts within a minute and takes a few minutes; the plan arrives as a message.";
  if (gate.wait === "limit") note = "Today's analysis limit is used up, so it runs tomorrow.";
  else if (gate.wait === "neurons") note = "Today's AI allowance is nearly used up, so it runs after 08:00 Malaysia time.";
  else if (gate.wait === "paused") {
    const until = localParts(new Date(gate.until!), env.OWNER_TZ);
    note = `The AI is busy, so analyses resume at ${String(until.hour).padStart(2, "0")}:${String(until.minute).padStart(2, "0")}.`;
  } else if (running && running.code !== c) note = `It starts after the analysis of ${running.code} finishes.`;
  return {
    code: c, status: added ? "queued" : "already queued",
    position: pending.findIndex((i) => i.code === c) + 1 || null, runs_left_today: gate.runsLeft, note,
  };
}

async function holdings(env: Env, store: Store, now: Date): Promise<Record<string, unknown>> {
  const positions = await store.lastPositions();
  const plans = await store.activePlans();
  let prices = new Map<string, { price: number; session: string }>();
  try {
    const token = await accessToken(env, store, now);
    if (token && positions.length) prices = await quotes(token, positions.map((p) => p.code), now);
  } catch {
    // live prices are optional here
  }
  return {
    last_sync: await store.getSetting("last_sync"),
    positions: positions.map((p) => {
      const plan = plans.find((x) => x.code === p.code);
      const q = prices.get(p.code);
      return {
        code: p.code, name: p.name, qty: p.qty, avg_cost: p.avgCost, price: q?.price ?? null, session: q?.session ?? null,
        pl_pct: q && p.avgCost ? Number((((q.price - p.avgCost) / p.avgCost) * 100).toFixed(2)) : null,
        plan: plan ? { action: plan.action, tp: plan.tp, sl: plan.sl } : null,
      };
    }),
  };
}

export async function runTool(env: Env, store: Store, name: string, args: Record<string, unknown>, now: Date): Promise<string> {
  try {
    switch (name) {
      case "get_holdings":
        return fit(await holdings(env, store, now), "positions");
      case "get_quote": {
        const c = code(args);
        const token = await accessToken(env, store, now);
        if (!token) return fit({ error: "moomoo isn't connected, so no live price." });
        const q = (await quotes(token, [c], now)).get(c);
        return fit(q ? { code: c, price: q.price, session: q.session } : { code: c, error: "no price right now" });
      }
      case "get_plan": {
        const c = code(args);
        const plan = await store.planFor(c);
        const report = await store.loadReport(c);
        return fit({
          code: c, plan: plan ? { ...planBrief(plan), holding_months: plan.holdingMonths, reasoning: plan.reasoning } : null,
          report_date: report?.at.slice(0, 10) ?? null, report: report?.text.slice(0, 1500) ?? null,
          ...(plan ? {} : { hint: "No plan yet; offer to run queue_analysis for it." }),
        });
      }
      case "list_plans":
        return fit({ plans: (await store.activePlans()).map(planBrief) }, "plans");
      case "get_news": {
        const c = code(args);
        return fit({ code: c, headlines: await headlines(c) }, "headlines");
      }
      case "queue_analysis":
        return fit(await queueAnalysis(env, store, code(args), now));
      default:
        return fit({ error: `unknown tool ${name}` });
    }
  } catch (e) {
    if (e instanceof ToolError) return fit({ error: e.message });
    console.error(`chat tool ${name} failed`, e instanceof Error ? e.name : typeof e);
    return fit({ error: `${name} failed (${e instanceof Error ? e.name : "error"})` });
  }
}
