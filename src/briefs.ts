/** The morning brief (after each US trading day) and the pre-open note: facts in code, one optional AI line. */
import { ask, neuronsToday } from "./ai";
import type { Env } from "./env";
import { type Facts, snapshotFacts } from "./market";
import { snapshotRows } from "./moomoo/api";
import { accessToken } from "./moomoo/oauth";
import { addDays, earnings, type EarningsItem } from "./moomoo/research";
import { aboutCompany, isMajor } from "./newsfilter";
import { headlines } from "./news";
import { DEFAULT_QUICK_MODEL } from "./pipeline";
import type { Plan } from "./plans";
import type { Position, Store } from "./store";
import { localParts } from "./time";

export const AI_SKIP_NEURONS = 8500; // briefs and notes drop their AI line from here, keeping neurons for analyses
const INDEXES: [string, string][] = [["US.SPY", "S&P 500"], ["US.QQQ", "Nasdaq 100"], ["US.DIA", "Dow"]];
const NEWS_MAX_AGE_MS = 36 * 3600_000;
const NEWS_HOLDINGS_MAX = 8; // one Yahoo call each, within the cron's 50-request budget
const SESSION_TEXT: Record<string, string> = { BEFORE: "before the open", AFTER: "after the close", REGULAR: "during the session" };

const signedPct = (v: number | null, digits = 2) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`);
const fromPrice = (level: number, price: number) => signedPct(((level - price) / price) * 100, 1);

/** The US trading calendar the minute cron keeps in D1. */
export async function storedTradingDays(store: Store): Promise<Set<string>> {
  const raw = await store.getSetting("trading_days");
  return new Set(raw ? (JSON.parse(raw) as string[]) : []);
}

/** Snapshot facts for ``codes``; empty when moomoo isn't connected or fails (the brief says so). */
export async function factsFor(env: Env, store: Store, codes: string[], now: Date): Promise<{ facts: Map<string, Facts>; token: string | null }> {
  try {
    const token = await accessToken(env, store, now);
    if (!token) return { facts: new Map(), token: null };
    try {
      return { facts: snapshotFacts(await snapshotRows(token, codes)), token };
    } catch (e) {
      console.error("brief snapshot failed", e instanceof Error ? e.name : typeof e);
      return { facts: new Map(), token };
    }
  } catch (e) {
    console.error("brief token failed", e instanceof Error ? e.name : typeof e);
    return { facts: new Map(), token: null };
  }
}

async function earningsAmong(token: string | null, codes: Set<string>, from: string, to: string): Promise<EarningsItem[] | null> {
  if (!token) return null;
  try {
    return (await earnings(token, from, to)).filter((i) => codes.has(i.code) && !i.published && i.date >= from && i.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    console.error("brief earnings failed", e instanceof Error ? e.name : typeof e);
    return null;
  }
}

/** A one-line holding summary: price, day change, P/L against cost, distance to the plan's stop and target. */
export function holdingLine(p: Position, f: Facts | undefined, plan: Plan | undefined): string {
  const price = f?.last ?? null;
  if (price === null) return `${p.code}: price unavailable`;
  const parts = [`${p.code} ${price.toFixed(2)} (${signedPct(f!.changePct)})`];
  if (p.avgCost) parts.push(`P/L ${signedPct(((price - p.avgCost) / p.avgCost) * 100, 1)}`);
  if (plan?.sl != null) parts.push(`stop ${plan.sl.toFixed(2)} (${fromPrice(plan.sl, price)})`);
  if (plan?.tp != null) parts.push(`target ${plan.tp.toFixed(2)} (${fromPrice(plan.tp, price)})`);
  return parts.join(" · ");
}

/** A short AI paragraph over the facts, or null when the budget is tight or the call fails. */
export async function aiLine(env: Env, store: Store, system: string, facts: string, maxTokens: number, now: Date): Promise<string | null> {
  if ((await neuronsToday(store, env, now)) >= AI_SKIP_NEURONS) return null;
  try {
    const text = await ask(env, store, env.QUICK_MODEL || DEFAULT_QUICK_MODEL, system, facts, maxTokens, now);
    return text || null;
  } catch (e) {
    console.error("brief AI line failed", e instanceof Error ? e.name : typeof e);
    return null;
  }
}

async function topHeadline(p: Position, now: Date): Promise<string | null> {
  const fresh = (await headlines(p.code)).filter((h) => h.at && now.getTime() - Date.parse(h.at) <= NEWS_MAX_AGE_MS);
  const hit = fresh.find((h) => isMajor(h.title) && aboutCompany(h.title, p.code, p.name));
  return hit ? `${p.code}: ${hit.title}${hit.publisher ? ` (${hit.publisher})` : ""}` : null;
}

const BRIEF_SYSTEM = "You write the closing line of a long-only investor's morning brief. In at most 80 words, say what " +
  "matters today for their holdings, using only the facts given. Never invent prices or news. Plain text, no greeting.";

/** The morning brief, or null when the New York day that just ended was not a trading day. */
export async function morningBrief(env: Env, store: Store, now: Date): Promise<string | null> {
  const nyDate = localParts(now, "America/New_York").date;
  if (!(await storedTradingDays(store)).has(nyDate)) return null;
  const positions = await store.lastPositions();
  const plans = await store.activePlans();
  const { facts, token } = await factsFor(env, store, [...INDEXES.map(([c]) => c), ...positions.map((p) => p.code)], now);

  const lines = [`☀️ **Morning brief (${nyDate})**`, ""];
  const indexes = INDEXES.filter(([c]) => facts.get(c)?.changePct != null);
  lines.push(indexes.length ? indexes.map(([c, name]) => `${name} ${signedPct(facts.get(c)!.changePct)}`).join(" · ") : "Index moves unavailable");

  if (positions.length) {
    lines.push("", "**Your holdings**");
    for (const p of positions) lines.push(holdingLine(p, facts.get(p.code), plans.find((x) => x.code === p.code && x.state === "HELD")));
  }

  const soon = await earningsAmong(token, new Set(positions.map((p) => p.code)), addDays(nyDate, 1), addDays(nyDate, 7));
  if (soon?.length) {
    lines.push("", "**Earnings in the next 7 days**",
      ...soon.map((i) => `${i.code} ${i.date}${i.when && SESSION_TEXT[i.when] ? ` (${SESSION_TEXT[i.when]})` : ""}`));
  } else if (soon === null && positions.length) {
    lines.push("", "Earnings calendar unavailable");
  }

  const news = (await Promise.all(positions.slice(0, NEWS_HOLDINGS_MAX).map((p) => topHeadline(p, now)))).filter((h): h is string => Boolean(h));
  if (news.length) lines.push("", "**Headlines**", ...news);

  const until = await store.getSetting("moomoo_until");
  if (until && Date.parse(until) > now.getTime() && Date.parse(until) - now.getTime() <= 3 * 86_400_000) {
    lines.push("", `🔑 Your moomoo sign-in expires on ${until.slice(0, 10)}. Send /reconnect to keep it connected.`);
  }

  const line = await aiLine(env, store, BRIEF_SYSTEM, lines.join("\n"), 160, now);
  if (line) lines.push("", `What matters today: ${line}`);
  return lines.join("\n");
}

/** The pre-open note: holdings' pre-market moves and today's earnings; null on a non-trading day or a quiet morning. */
export async function preOpenNote(env: Env, store: Store, now: Date): Promise<string | null> {
  const nyDate = localParts(now, "America/New_York").date;
  if (!(await storedTradingDays(store)).has(nyDate)) return null;
  const positions = await store.lastPositions();
  if (!positions.length) return null;
  const { facts, token } = await factsFor(env, store, positions.map((p) => p.code), now);
  const movers = positions
    .map((p) => ({ p, f: facts.get(p.code) }))
    .filter(({ f }) => f?.prePrice != null && f.preChangePct != null && Math.abs(f.preChangePct) >= 0.01)
    .sort((a, b) => Math.abs(b.f!.preChangePct!) - Math.abs(a.f!.preChangePct!));
  const today = await earningsAmong(token, new Set(positions.map((p) => p.code)), nyDate, nyDate);
  if (!movers.length && !today?.length) return null;
  const lines = [`🌅 **Before the US open (${nyDate})**`];
  for (const { p, f } of movers) lines.push(`${p.code} pre-market ${f!.prePrice!.toFixed(2)} (${signedPct(f!.preChangePct)})`);
  if (today?.length) {
    lines.push("", ...today.map((i) => `Earnings today: ${i.code}${i.when && SESSION_TEXT[i.when] ? ` (${SESSION_TEXT[i.when]})` : ""}`));
  }
  return lines.join("\n");
}
