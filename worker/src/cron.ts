/** Runs every minute: trading calendar, holdings sync and the stop-loss warning. */
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

type Trigger = { plan: Plan; quote: Quote };

/** Held plans at or below their stop. Throws when a regular-session snapshot holds no prices at all. */
async function findStops(store: Store, token: string, now: Date, regular: boolean): Promise<Trigger[] | null> {
  const plans = (await store.activePlans()).filter((p) => p.state === "HELD" && p.sl !== null && !p.fired.includes("SL"));
  if (!plans.length) return null;
  const prices = await quotes(token, [...new Set(plans.map((p) => p.code))], now);
  // Outside regular hours a session field can legitimately be empty; in it, no price at all means a broken answer.
  if (regular && !prices.size) throw new Error("snapshot without prices");
  const triggers: Trigger[] = [];
  for (const plan of plans) {
    const quote = prices.get(plan.code);
    if (quote && quote.price <= plan.sl!) triggers.push({ plan, quote }); // no price, no decision
  }
  return triggers;
}

/** One message for all triggered stops; plans are marked fired only once Telegram accepted it. */
async function warn(env: Env, store: Store, triggers: Trigger[]): Promise<void> {
  const lines = triggers.map(({ plan, quote }) => `⚠️ Stop-loss: ${plan.code} at ${quote.price.toFixed(2)} ` +
    `(stop ${plan.sl!.toFixed(2)}, ${SESSION_LABEL[quote.session]} trading). Review this position.`);
  if (!(await trySend(env, lines.join("\n")))) return; // retried next minute
  for (const { plan } of triggers) await store.updatePlan({ ...plan, fired: [...plan.fired, "SL"] });
}

async function failed(env: Env, store: Store): Promise<void> {
  const count = Number((await store.getSetting("moomoo_failures")) ?? 0) + 1;
  await store.setSetting("moomoo_failures", String(count));
  if (count === FAILURES_BEFORE_NOTE) {
    await store.setSetting("moomoo_down", "1");
    await send(env, "moomoo is unreachable; stop-loss checks are paused.");
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
      const found = await findStops(store, token, now, regular);
      if (found) [triggers, contacted] = [found, true];
    }
  } catch (e) {
    console.error("moomoo minute failed", e instanceof Error ? e.name : typeof e); // the message may carry tokens
    return failed(env, store);
  }
  if (contacted) await succeeded(env, store);
  if (syncMessages.length) await send(env, syncMessages.join("\n\n"));
  if (triggers.length) await warn(env, store, triggers);
}
