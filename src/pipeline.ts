/**
 * The analysis: verified data first, then the TradingAgents roles, one AI call each, then a checked plan.
 * Each stage is a ``step.do`` so a Workflow can resume a run without repeating finished (paid) calls.
 */
import { ask } from "./ai";
import { buildDataSheet, type DataSheet } from "./datasheet";
import type { Env } from "./env";
import { extractPlan } from "./extract";
import { applyNewAnalysis } from "./lifecycle";
import { formatInvalidPlan, formatNoPlan, formatPlan } from "./messages";
import { quotes } from "./moomoo/api";
import { accessToken } from "./moomoo/oauth";
import type { PlanFields } from "./plans";
import { type Role, SKILLS } from "./skills";
import type { Position, QueueItem, Store } from "./store";
import { send } from "./telegram";

export interface Step {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export const DEFAULT_QUICK_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const DEFAULT_DEEP_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEEP_ROLES = new Set<Role>(["research_manager", "trader", "portfolio_manager"]);
const MAX_TOKENS: Record<Role, number> = {
  market_analyst: 500, news_analyst: 400, fundamentals_analyst: 500, bull: 450, bear: 450, research_manager: 500,
  trader: 500, risk_aggressive: 350, risk_neutral: 350, risk_conservative: 350, portfolio_manager: 600,
};

export interface PipelineDeps {
  sheet: (token: string, code: string, now: Date) => Promise<DataSheet>;
  token: (env: Env, store: Store, now: Date) => Promise<string | null>;
  /** Live prices for the held codes, used to size the analysed position within the portfolio. */
  prices?: (token: string, codes: string[], now: Date) => Promise<Map<string, number>>;
}
const livePrices = async (token: string, codes: string[], now: Date) =>
  new Map([...(await quotes(token, codes, now))].map(([code, q]) => [code, q.price]));
const DEFAULT_DEPS: PipelineDeps = { sheet: buildDataSheet, token: accessToken, prices: livePrices };

/** "The investor holds ..." with the position's profit or loss and its share of the portfolio by market value. */
function holdingText(position: Position | undefined, positions: Position[], price: number, prices: Map<string, number>): string {
  if (!position) return "The investor does not hold this stock.";
  const cost = position.avgCost;
  const pl = cost ? ` (currently ${price >= cost ? "+" : ""}${(((price - cost) / cost) * 100).toFixed(1)}% vs cost)` : "";
  // Missing quotes fall back to the cost; a position with neither is left out of the total.
  const value = (p: Position) => p.qty * (p.code === position.code ? price : prices.get(p.code) ?? p.avgCost ?? 0);
  const total = positions.reduce((sum, p) => sum + value(p), 0);
  const share = total > 0 ? `, about ${((value(position) / total) * 100).toFixed(0)}% of their portfolio by market value` : "";
  return `The investor holds ${position.qty} shares at an average cost of ${cost?.toFixed(2) ?? "unknown"}${pl}${share}.`;
}

type Outcome = { fields: PlanFields } | { errors: string[] };

export async function runAnalysis(step: Step, env: Env, store: Store, item: QueueItem, now: Date,
  deps: PipelineDeps = DEFAULT_DEPS): Promise<void> {
  const code = item.code;
  const sheet = await step.do("data", async () => {
    const token = await deps.token(env, store, now);
    if (!token) throw new Error("moomoo isn't connected");
    return deps.sheet(token, code, now);
  });
  const positions = await store.lastPositions();
  const position = positions.find((p) => p.code === code);
  const prices = position ? await step.do("portfolio", async () => {
    try {
      const token = await deps.token(env, store, now);
      const found = token ? await (deps.prices ?? livePrices)(token, positions.map((p) => p.code), now) : new Map<string, number>();
      return [...found]; // step results must be serializable
    } catch (e) {
      console.error("portfolio prices failed", e instanceof Error ? e.name : typeof e);
      return [] as [string, number][];
    }
  }) : [];
  const holding = holdingText(position, positions, sheet.price, new Map(prices));

  // Once an AI call has been paid for, a later failure keeps the run counted against the daily limit.
  const paid = <T>(answer: T) => store.setSetting(`analysis_paid:${item.id}`, "1").then(() => answer);
  const call = (role: Role, context: string) => step.do(role, async () => paid(await
    ask(env, store, DEEP_ROLES.has(role) ? env.DEEP_MODEL || DEFAULT_DEEP_MODEL : env.QUICK_MODEL || DEFAULT_QUICK_MODEL,
      SKILLS[role], `Stock: ${code}\n${holding}\n\n${sheet.text}${context ? `\n\n${context}` : ""}`, MAX_TOKENS[role], now)));

  const market = await call("market_analyst", "");
  const news = await call("news_analyst", "");
  const fundamentals = await call("fundamentals_analyst", "");
  const analysts = `## Market report\n${market}\n\n## News report\n${news}\n\n## Fundamentals report\n${fundamentals}`;
  const bull = await call("bull", analysts);
  const bear = await call("bear", `${analysts}\n\n## Bull case\n${bull}`);
  const debate = `## Bull case\n${bull}\n\n## Bear case\n${bear}`;
  const manager = await call("research_manager", `${analysts}\n\n${debate}`);
  const trader = await call("trader", `## Market report\n${market}\n\n## Research manager's plan\n${manager}`);
  const proposal = `## Research manager's plan\n${manager}\n\n## Trader's proposal\n${trader}`;
  const aggressive = await call("risk_aggressive", `${analysts}\n\n${proposal}`);
  const neutral = await call("risk_neutral", `${analysts}\n\n${proposal}\n\n## Aggressive view\n${aggressive}`);
  const conservative = await call("risk_conservative",
    `${analysts}\n\n${proposal}\n\n## Aggressive view\n${aggressive}\n\n## Neutral view\n${neutral}`);
  const risk = `## Aggressive view\n${aggressive}\n\n## Neutral view\n${neutral}\n\n## Conservative view\n${conservative}`;

  const outcome = await step.do<Outcome>("portfolio_manager", () => extractPlan((extra) =>
    ask(env, store, env.DEEP_MODEL || DEFAULT_DEEP_MODEL, SKILLS.portfolio_manager,
      `Stock: ${code}\n${holding}\n\n${sheet.text}\n\n${analysts}\n\n${proposal}\n\n${risk}${extra ? `\n\n${extra}` : ""}`,
      MAX_TOKENS.portfolio_manager, now), sheet.price, position?.avgCost ?? null));

  const report = [`# Analysis of ${code}, ${now.toISOString().slice(0, 10)} (price ${sheet.price.toFixed(2)})`, analysts,
    debate, `## Research manager\n${manager}`, `## Trader\n${trader}`, risk,
    "fields" in outcome ? `## Decision\n${outcome.fields.action}: ${outcome.fields.reasoning}` : `## Decision\nNo valid plan: ${outcome.errors.join("; ")}`,
  ].join("\n\n");

  await step.do("save", async () => {
    // Save only for a run still in progress: not twice (done), and not after it was stopped (failed).
    if ((await store.queueItem(item.id))?.status !== "running") return true;
    await store.saveReport(code, report, sheet.price, now);
    let message: string;
    if ("fields" in outcome) {
      const plan = await applyNewAnalysis(store, code, outcome.fields, Boolean(position), now);
      message = plan ? formatPlan(plan, sheet.price, position?.avgCost ?? null) : formatNoPlan(code, outcome.fields);
    } else {
      message = formatInvalidPlan(code, outcome.errors);
    }
    await store.setQueueStatus(item.id, "done");
    await send(env, message);
    await store.logChat("alert", message, now); // so the chat knows what it told you
    return true;
  });
}
