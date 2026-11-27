/**
 * Event notes: major relevant news, a 5% move and analyst consensus changes on watched stocks, at most
 * EVENTS_PER_DAY a day. An event on a held stock also queues a fresh analysis, once per stock per day.
 */
import { aiLine, factsFor } from "./briefs";
import type { Env } from "./env";
import { accessToken } from "./moomoo/oauth";
import { consensus } from "./moomoo/research";
import { aboutCompany, isMajor } from "./newsfilter";
import { headlines } from "./news";
import type { Store } from "./store";
import { send } from "./telegram";
import { localParts } from "./time";
import { analysisGate } from "./workflow";

export const EVENTS_PER_DAY = 3;
export const MOVE_PCT = 5;
const CONSENSUS_MOVE_PCT = 5;
const NEWS_MAX_AGE_MS = 24 * 3600_000;
const NEWS_CODES_MAX = 8; // one Yahoo call each, within the cron's 50-request budget

const SO_WHAT = "In at most 60 words, tell a long-only investor what this event means for them, using only the facts " +
  "given (their position and plan included). Never invent prices or news. Plain text, no greeting.";

type Event = { code: string; key: string; fact: string };

/** Stocks worth watching: holdings first, then stocks with an active plan. */
async function watched(store: Store): Promise<{ code: string; name: string; held: boolean }[]> {
  const positions = await store.lastPositions();
  const out = positions.map((p) => ({ code: p.code, name: p.name, held: true }));
  for (const plan of await store.activePlans()) {
    if (!out.some((w) => w.code === plan.code)) out.push({ code: plan.code, name: "", held: false });
  }
  return out;
}

async function context(store: Store, code: string): Promise<string> {
  const position = (await store.lastPositions()).find((p) => p.code === code);
  const plan = await store.planFor(code);
  return [
    position ? `The investor holds ${position.qty} shares at an average cost of ${position.avgCost?.toFixed(2) ?? "unknown"}.`
      : "The investor does not hold this stock.",
    plan ? `Their plan: ${plan.action}, take-profit ${plan.tp ?? "n/a"}, stop-loss ${plan.sl ?? "n/a"}.` : "No plan.",
  ].join(" ");
}

/** Send the events that fit today's cap; each is marked seen even when the cap holds it back. */
async function deliver(env: Env, store: Store, events: Event[], now: Date): Promise<string[]> {
  const date = localParts(now, env.OWNER_TZ).date;
  const capKey = `events:${date}`;
  const held = new Set((await store.lastPositions()).map((p) => p.code));
  const sent: string[] = [];
  for (const ev of events) {
    if (!(await store.markOnce(ev.key, now))) continue;
    const count = Number((await store.getSetting(capKey)) ?? 0);
    if (count >= EVENTS_PER_DAY) continue;
    await store.setSetting(capKey, String(count + 1));
    const lines = [`📣 ${ev.fact}`];
    const soWhat = await aiLine(env, store, SO_WHAT, `${ev.fact}\n${await context(store, ev.code)}`, 120, now);
    if (soWhat) lines.push(`So what: ${soWhat}`);
    if (held.has(ev.code) && (await store.markOnce(`event-analysis:${ev.code}:${date}`, now))) {
      await store.enqueue(ev.code, "event", 1, now);
      const gate = await analysisGate(env, store, now);
      lines.push(gate.wait === "limit" ? "I've queued a fresh analysis; it runs once today's analysis limit resets."
        : gate.wait ? "I've queued a fresh analysis; it starts when the AI budget allows."
        : "I've queued a fresh analysis.");
    }
    const text = lines.join("\n");
    await send(env, text);
    await store.logChat("alert", text, now);
    sent.push(text);
  }
  return sent;
}

/** News and big moves on watched stocks (every 30 minutes inside the price window). Returns the notes sent. */
export async function checkEvents(env: Env, store: Store, now: Date): Promise<string[]> {
  const stocks = await watched(store);
  if (!stocks.length) return [];
  const nyDate = localParts(now, "America/New_York").date;
  const { facts } = await factsFor(env, store, stocks.map((s) => s.code), now);
  const events: Event[] = [];
  for (const s of stocks) {
    const f = facts.get(s.code);
    if (f?.changePct != null && f.last !== null && Math.abs(f.changePct) >= MOVE_PCT) {
      events.push({ code: s.code, key: `move:${s.code}:${nyDate}`,
        fact: `${s.code} is ${f.changePct > 0 ? "up" : "down"} ${Math.abs(f.changePct).toFixed(2)}% today at ${f.last.toFixed(2)}.` });
    }
  }
  const news = await Promise.all(stocks.slice(0, NEWS_CODES_MAX).map(async (s) => {
    const name = s.name || facts.get(s.code)?.name || "";
    return (await headlines(s.code))
      .filter((h) => h.at && now.getTime() - Date.parse(h.at) <= NEWS_MAX_AGE_MS && isMajor(h.title) && aboutCompany(h.title, s.code, name))
      .map((h) => ({ code: s.code, key: `news:${s.code}:${h.title}`, fact: `${s.code}: ${h.title}${h.publisher ? ` (${h.publisher})` : ""}` }));
  }));
  return deliver(env, store, [...events, ...news.flat()], now);
}

/** Analyst consensus changes on holdings (once a day): a new rating, or the average target moved 5% or more. */
export async function checkConsensus(env: Env, store: Store, now: Date): Promise<string[]> {
  const token = await accessToken(env, store, now);
  if (!token) return [];
  const date = localParts(now, env.OWNER_TZ).date;
  const events: Event[] = [];
  for (const p of await store.lastPositions()) {
    let current;
    try {
      current = await consensus(token, p.code);
    } catch (e) {
      console.error("consensus check failed", e instanceof Error ? e.name : typeof e);
      continue;
    }
    if (!current) continue;
    const before = await store.consensusFor(p.code);
    await store.saveConsensus(p.code, current.rating, current.average, now);
    if (!before) continue; // the first reading is only recorded
    const facts: string[] = [];
    if (before.rating !== null && current.rating !== null && before.rating !== current.rating) {
      facts.push(`rating went from ${before.rating}/5 to ${current.rating}/5`);
    }
    if (before.average && current.average) {
      const moved = ((current.average - before.average) / before.average) * 100;
      if (Math.abs(moved) >= CONSENSUS_MOVE_PCT) {
        facts.push(`average target moved from ${before.average.toFixed(2)} to ${current.average.toFixed(2)} ` +
          `(${moved >= 0 ? "+" : ""}${moved.toFixed(1)}%)`);
      }
    }
    if (facts.length) events.push({ code: p.code, key: `consensus:${p.code}:${date}`, fact: `${p.code} analysts' ${facts.join("; ")}.` });
  }
  return deliver(env, store, events, now);
}
