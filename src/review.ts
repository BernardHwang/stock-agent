/** The Sunday review: the week in numbers, the plan scorecard and up to 3 screener ideas (the top one queued). */
import { aiLine, factsFor } from "./briefs";
import type { Env } from "./env";
import { type Idea, screen } from "./screener";
import type { Store } from "./store";

const INDEXES: [string, string][] = [["US.SPY", "S&P 500"], ["US.QQQ", "Nasdaq 100"]];
const signedPct = (v: number | null, digits = 2) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`);

const THESIS = "For each stock idea below, write one line \"CODE: thesis\" of at most 20 words: why it may be worth a " +
  "look for a long-only investor holding 3-12 months, using only the numbers given. One line per idea, nothing else.";

function ideaLine(i: Idea, thesis: string | undefined): string {
  const facts = `${i.code} ${i.name} ${i.price.toFixed(2)} (${signedPct(i.revenueGrowth, 0)} revenue, ` +
    `${signedPct(i.earningsGrowth, 0)} earnings, ${i.reason})`;
  return thesis ? `${facts}: ${thesis}` : facts;
}

export async function sundayReview(env: Env, store: Store, now: Date): Promise<string> {
  const positions = await store.lastPositions();
  const { facts, token } = await factsFor(env, store, [...INDEXES.map(([c]) => c), ...positions.map((p) => p.code)], now);
  const lines = ["🗓 **Weekly review**", ""];

  const indexes = INDEXES.filter(([c]) => facts.get(c)?.weekChangePct != null);
  lines.push(indexes.length ? `This week: ${indexes.map(([c, n]) => `${n} ${signedPct(facts.get(c)!.weekChangePct)}`).join(" · ")}`
    : "Index week changes unavailable");

  if (positions.length) {
    lines.push("", "**Your holdings**");
    for (const p of positions) {
      const f = facts.get(p.code);
      if (f?.last == null) {
        lines.push(`${p.code}: price unavailable`);
        continue;
      }
      const pl = p.avgCost ? `, P/L ${signedPct(((f.last - p.avgCost) / p.avgCost) * 100, 1)}` : "";
      lines.push(`${p.code} ${f.last.toFixed(2)}, week ${signedPct(f.weekChangePct)}${pl}`);
    }
  }

  const card = await store.scorecard();
  lines.push("", "**Plan scorecard**", card.scored
    ? `${card.scored} plans scored: ${card.targets} hit the target first, ${card.stops} the stop; average 12-week return ` +
      `${card.avg12w === null ? "n/a" : signedPct(card.avg12w * 100, 1)}`
    : "Plan scorecard: not enough history yet");

  let ideas: Idea[] | null = null;
  if (token) {
    try {
      ideas = await screen(token, new Set(positions.map((p) => p.code)));
    } catch (e) {
      console.error("screener failed", e instanceof Error ? e.name : typeof e);
    }
  }
  lines.push("", "**Ideas**");
  if (ideas === null) {
    lines.push("Screener ideas are unavailable this week.");
  } else if (!ideas.length) {
    lines.push("No stock in the universe passed the screen this week.");
  } else {
    const answer = await aiLine(env, store, THESIS, ideas.map((i) => ideaLine(i, undefined)).join("\n"), 200, now);
    const theses = new Map<string, string>();
    for (const line of (answer ?? "").split("\n")) {
      const m = line.match(/^\s*[-*]?\s*(US\.[A-Z0-9.]+)\s*:\s*(.+)$/);
      if (m) theses.set(m[1]!, m[2]!.trim());
    }
    lines.push(...ideas.map((i) => ideaLine(i, theses.get(i.code))));
    const top = ideas[0]!;
    if (await store.enqueue(top.code, "screener", 3, now)) lines.push("", `I've queued a full analysis of ${top.code}; its plan arrives as a message.`);
  }
  lines.push("", 'Say "analyze <ticker>" for a full analysis.');
  return lines.join("\n");
}
