/** Runs every minute: trading calendar, holdings sync and the stop-loss warning. */
import type { Env } from "./env";
import { syncFromMoomoo } from "./holdings";
import { quotes, type Session, tradingDays } from "./moomoo/api";
import { accessToken } from "./moomoo/oauth";
import type { Store } from "./store";
import { send } from "./telegram";
import { inPriceWindow, inUsSession, localParts } from "./time";

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
async function calendar(store: Store, token: string, now: Date): Promise<Set<string>> {
  const today = localParts(now, "America/New_York").date;
  const cached = await store.getSetting("trading_days");
  if (cached && (await store.getSetting("trading_days_on")) === today) return new Set(JSON.parse(cached) as string[]);
  const days = await tradingDays(token, addDays(today, -3), addDays(today, 40));
  await store.setSetting("trading_days", JSON.stringify([...days]));
  await store.setSetting("trading_days_on", today);
  return days;
}

async function checkStops(env: Env, store: Store, token: string): Promise<void> {
  const plans = (await store.activePlans()).filter((p) => p.state === "HELD" && p.sl !== null && !p.fired.includes("SL"));
  if (!plans.length) return;
  const prices = await quotes(token, [...new Set(plans.map((p) => p.code))]);
  for (const plan of plans) {
    const quote = prices.get(plan.code);
    if (!quote || quote.price > plan.sl!) continue; // no price, no decision
    await store.updatePlan({ ...plan, fired: [...plan.fired, "SL"] });
    await send(env, `⚠️ Stop-loss: ${plan.code} at ${quote.price.toFixed(2)} (stop ${plan.sl!.toFixed(2)}, ` +
      `${SESSION_LABEL[quote.session]} trading). Review this position.`);
  }
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
  let token: string | null;
  try {
    token = await accessToken(env, store, now);
    if (!token) return; // not connected
    const days = await calendar(store, token, now);
    const ny = localParts(now, "America/New_York");
    const local = localParts(now, env.OWNER_TZ);
    const dailySync = local.hour === 7 && local.minute === 55 && (await store.markOnce(`sync:${local.date}`, now));
    if ((inUsSession(now, days) && ny.minute % 15 === 0) || dailySync) {
      const result = await syncFromMoomoo(env, store, now);
      if (result?.messages.length) await send(env, result.messages.join("\n\n"));
    }
    if (inPriceWindow(now, days, env.PRICE_HOURS)) await checkStops(env, store, token);
  } catch (e) {
    console.error("moomoo minute failed", e instanceof Error ? e.name : typeof e); // the message may carry tokens
    return failed(env, store);
  }
  await succeeded(env, store);
}
