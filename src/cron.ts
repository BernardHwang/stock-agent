/** Runs every minute: trading calendar, holdings sync and the plan level alerts (stop, targets, buy zone). */
import type { Env } from "./env";
import { syncFromMoomoo } from "./holdings";
import { type Quote, quotes, tradingDays } from "./moomoo/api";
import { accessToken } from "./moomoo/oauth";
import type { Plan } from "./plans";
import type { Store } from "./store";
import { send, trySend } from "./telegram";
import { inPriceWindow, inUsSession, localParts, type Session } from "./time";

const FAILURES_BEFORE_NOTE = 3;
const SESSION_LABEL: Record<Session, string> = {
  overnight: "overnight", pre: "pre-market", regular: "regular", after: "after-hours",
};

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The US trading calendar, refreshed from moomoo once per New York day. */
async function calendar(store: Store, token: string, now: Date): Promise<{ days: Set<string>; fetched: boolean }> {
  const today = localParts(now, "America/New_York").date;
  const cached = await store.getSetting("trading_days");
  if (cached && (await store.getSetting("trading_days_on")) === today) {
    return { days: new Set(JSON.parse(cached) as string[]), fetched: false };
  }
  const days = await tradingDays(token, addDays(today, -3), addDays(today, 40));
  // Six weeks always hold trading days; none means the answer wasn't understood, and must not pause checks silently.
  if (!days.size) throw new Error("empty trading calendar");
  await store.setSetting("trading_days", JSON.stringify([...days]));
  await store.setSetting("trading_days_on", today);
  return { days, fetched: true };
}

type Level = "SL" | "PARTIAL_TP" | "TP" | "ENTRY" | "EXPIRED";
type Trigger = { plan: Plan; quote: Quote; level: Level };

/** The levels a price crosses on a plan, each at most once (ported from the Python RuleEngine at 9c81be3). */
function crossed(plan: Plan, price: number): Level[] {
  const fired = new Set(plan.fired);
  if (plan.state === "HELD") {
    const out: Level[] = [];
    if (plan.sl !== null && price <= plan.sl && !fired.has("SL")) out.push("SL");
    if (plan.partialTp !== null && price >= plan.partialTp && !fired.has("PARTIAL_TP")) out.push("PARTIAL_TP");
    if (plan.tp !== null && price >= plan.tp && !fired.has("TP")) out.push("TP");
    return out;
  }
  // Not bought yet: a broken stop cancels the plan; the zone is announced once.
  if (plan.sl !== null && price <= plan.sl) return ["EXPIRED"];
  if (plan.state === "OPEN" && plan.entryLow !== null && plan.entryHigh !== null && price >= plan.entryLow &&
    price <= plan.entryHigh && !fired.has("ENTRY")) return ["ENTRY"];
  return [];
}

/** Levels crossed on watched plans. Throws when a regular-session snapshot holds no prices at all. */
async function findLevels(store: Store, token: string, now: Date, regular: boolean): Promise<Trigger[] | null> {
  const plans = (await store.activePlans()).filter((p) => p.state !== "HELD" || p.sl !== null || p.tp !== null);
  if (!plans.length) return null;
  const prices = await quotes(token, [...new Set(plans.map((p) => p.code))], now);
  // Outside regular hours a session field can legitimately be empty; in it, no price at all means a broken answer.
  if (regular && !prices.size) throw new Error("snapshot without prices");
  const triggers: Trigger[] = [];
  for (const plan of plans) {
    const quote = prices.get(plan.code);
    if (quote) for (const level of crossed(plan, quote.price)) triggers.push({ plan, quote, level }); // no price, no decision
  }
  return triggers;
}

function alertLine({ plan, quote, level }: Trigger): string {
  const at = `${plan.code} at ${quote.price.toFixed(2)}`;
  const session = `${SESSION_LABEL[quote.session]} trading`;
  switch (level) {
    case "SL":
      return `⚠️ Stop-loss: ${at} (stop ${plan.sl!.toFixed(2)}, ${session}). Review this position.`;
    case "PARTIAL_TP":
      return `💰 Partial take-profit: ${at} (target ${plan.partialTp!.toFixed(2)}, ${session}). ` +
        "A good spot to lock in some gains and trail your stop on the rest.";
    case "TP":
      return `✅ Take-profit: ${at} (target ${plan.tp!.toFixed(2)}, ${session}). ` +
        "Consider taking profits here, or trail a tight stop if momentum is still strong.";
    case "ENTRY":
      return `🎯 Buy zone: ${at} (zone ${plan.entryLow!.toFixed(2)} - ${plan.entryHigh!.toFixed(2)}, ${session}). ` +
        "Plan #" + plan.id + "'s entry is here; check your position size before buying.";
    case "EXPIRED":
      return `⌛ ${plan.code} fell to ${quote.price.toFixed(2)}, below plan #${plan.id}'s stop ${plan.sl!.toFixed(2)} before ` +
        "you bought, so I've cancelled that plan.";
  }
}

/** One message for all crossed levels; plans change only once Telegram accepted it. */
async function warn(env: Env, store: Store, triggers: Trigger[], now: Date): Promise<void> {
  const text = triggers.map(alertLine).join("\n");
  if (!(await trySend(env, text))) return; // retried next minute
  await store.logChat("alert", text, now); // so the chat knows what it told you
  const byPlan = new Map<number, Trigger[]>();
  for (const t of triggers) byPlan.set(t.plan.id, [...(byPlan.get(t.plan.id) ?? []), t]);
  for (const list of byPlan.values()) {
    const plan = list[0]!.plan;
    const levels = list.map((t) => t.level);
    const state = levels.includes("EXPIRED") ? "EXPIRED" : levels.includes("ENTRY") ? "TRIGGERED" : plan.state;
    const fired = [...plan.fired, ...levels.map((l) => (l === "EXPIRED" ? "SL" : l))];
    await store.updatePlan({ ...plan, state, fired });
  }
}

async function failed(env: Env, store: Store): Promise<void> {
  const count = Number((await store.getSetting("moomoo_failures")) ?? 0) + 1;
  await store.setSetting("moomoo_failures", String(count));
  if (count === FAILURES_BEFORE_NOTE) {
    await store.setSetting("moomoo_down", "1");
    await send(env, "moomoo isn't answering as expected; stop-loss checks are paused.");
  }
}

async function succeeded(env: Env, store: Store): Promise<void> {
  await store.setSetting("moomoo_failures", "");
  if (await store.getSetting("moomoo_down")) {
    await store.setSetting("moomoo_down", "");
    await send(env, "moomoo is reachable again.");
  }
}

export async function runMinute(env: Env, store: Store, now: Date): Promise<void> {
  let contacted = false; // only a minute that really reached moomoo may report it reachable again
  let triggers: Trigger[] = [];
  let syncMessages: string[] = [];
  try {
    const token = await accessToken(env, store, now);
    if (!token) return; // not connected
    const { days, fetched } = await calendar(store, token, now);
    contacted ||= fetched;
    const ny = localParts(now, "America/New_York");
    const local = localParts(now, env.OWNER_TZ);
    const regular = inUsSession(now, days);
    const dailySync = local.hour === 7 && local.minute === 55 && (await store.markOnce(`sync:${local.date}`, now));
    if ((regular && ny.minute % 15 === 0) || dailySync) {
      syncMessages = (await syncFromMoomoo(env, store, now))?.messages ?? [];
      contacted = true;
    }
    if (inPriceWindow(now, days, env.PRICE_HOURS)) {
      const found = await findLevels(store, token, now, regular);
      if (found) [triggers, contacted] = [found, true];
    }
  } catch (e) {
    console.error("moomoo minute failed", e instanceof Error ? e.name : typeof e); // the message may carry tokens
    return failed(env, store);
  }
  if (contacted) await succeeded(env, store);
  if (syncMessages.length) await send(env, syncMessages.join("\n\n"));
  if (triggers.length) await warn(env, store, triggers, now);
}
