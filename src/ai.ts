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
  const text = textOf(out.response).trim();
  if (!calls.length && tools.length) {
    // Llama sometimes writes its tool call as text that Workers AI doesn't lift into tool_calls.
    const fromText = textToolCalls(text, tools.map((t) => t.name));
    if (fromText.length) return { text: "", toolCalls: fromText };
  }
  return { text, toolCalls: calls };
}

/** Top-level JSON values in ``text``, or null when anything else (prose) is in it. */
function jsonValues(text: string): unknown[] | null {
  const values: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/[\s;,]/.test(c)) {
      i++;
      continue;
    }
    if (c !== "{" && c !== "[") return null;
    let depth = 0;
    let inString = false;
    let j = i;
    for (; j < text.length; j++) {
      const ch = text[j]!;
      if (inString) {
        if (ch === "\\") j++;
        else if (ch === "\"") inString = false;
      } else if (ch === "\"") inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    try {
      values.push(JSON.parse(text.slice(i, j + 1)));
    } catch {
      return null;
    }
    i = j + 1;
  }
  return values;
}

/**
 * Tool calls written as text, in Llama's forms: {"type":"function","function":{"name","parameters"}},
 * {"name","parameters"|"arguments"}, a list of those, or several separated by ";". Only when the whole text is
 * such calls and every name is one of ``names``; otherwise it is an answer and [] is returned.
 */
export function textToolCalls(text: string, names: string[]): ToolCall[] {
  const values = jsonValues(text.replace(/<\|python_tag\|>/g, "").trim());
  if (!values?.length) return [];
  const calls: ToolCall[] = [];
  for (const item of values.flatMap((v) => (Array.isArray(v) ? v : [v]))) {
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
    const f = (o.function && typeof o.function === "object" ? o.function : o) as Record<string, unknown>;
    if (typeof f.name !== "string" || !names.includes(f.name)) return [];
    calls.push({ name: f.name, arguments: parseArgs(f.parameters ?? f.arguments) });
  }
  return calls;
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
