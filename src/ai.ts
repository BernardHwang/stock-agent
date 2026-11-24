/** Workers AI calls with a daily neuron tally (the free plan allows 10,000 a day, reset 00:00 UTC). */
import { estimateNeurons } from "./aiprobe";
import type { Env } from "./env";
import type { Store } from "./store";

/** Cloudflare refused for capacity (3040), the daily allowance (3036) or rate limiting (429). */
export class AiRateLimited extends Error {
  constructor(message: string) {
    super(`AiRateLimited: ${message}`); // the marker survives Workflows re-creating the error as a plain Error
    this.name = "AiRateLimited";
  }
}

/** True for AiRateLimited, also after a Workflow step re-threw it as a plain Error with only the message kept. */
export function isRateLimited(e: unknown): boolean {
  if (e instanceof AiRateLimited) return true;
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /AiRateLimited/.test(text) || RATE_LIMIT.test(text);
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const RATE_LIMIT = /\b(429|3036|3040)\b|capacity|rate limit|too many requests/i;
// Cloudflare's allowance resets at 00:00 UTC, so the tally is per UTC day.
const tallyKey = (now: Date) => `neurons:${now.toISOString().slice(0, 10)}`;

export async function neuronsToday(store: Store, _env: Env, now: Date): Promise<number> {
  return Number((await store.getSetting(tallyKey(now))) ?? 0);
}

async function tally(store: Store, model: string, usage: { prompt_tokens?: number; completion_tokens?: number } | undefined, now: Date) {
  const used = estimateNeurons(model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0) ?? 0;
  if (used > 0) await store.setSetting(tallyKey(now), String(Number((await store.getSetting(tallyKey(now))) ?? 0) + used));
}

async function run(env: Env, model: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return (await env.AI.run(model as keyof AiModels, input as never)) as unknown as Record<string, unknown>; // never streamed
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (RATE_LIMIT.test(message)) throw new AiRateLimited(message);
    throw e;
  }
}

const textOf = (response: unknown) => (typeof response === "string" ? response : response == null ? "" : JSON.stringify(response));

/** One plain completion. */
export async function ask(env: Env, store: Store, model: string, system: string, user: string, maxTokens: number,
  now: Date): Promise<string> {
  const out = await run(env, model, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens,
  });
  await tally(store, model, out.usage as never, now);
  return textOf(out.response).trim();
}

/** One completion that may request tools (Workers AI function calling). */
export async function askWithTools(env: Env, store: Store, model: string, messages: ChatMessage[], tools: ToolDef[],
  maxTokens: number, now: Date): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const out = await run(env, model, { messages, ...(tools.length ? { tools } : {}), max_tokens: maxTokens });
  await tally(store, model, out.usage as never, now);
  const calls = ((out.tool_calls as { name?: unknown; arguments?: unknown }[] | undefined) ?? [])
    .filter((c) => typeof c.name === "string")
    .map((c) => ({ name: String(c.name), arguments: parseArgs(c.arguments) }));
  return { text: textOf(out.response).trim(), toolCalls: calls };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}
