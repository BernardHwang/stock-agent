/** One chat turn: recent history, tools (at most 4 rounds), then an answer. Never silent, never over budget. */
import { AiRateLimited, askWithTools, type ChatMessage, neuronsToday } from "../ai";
import type { Env } from "../env";
import { DEFAULT_DEEP_MODEL } from "../pipeline";
import type { Store } from "../store";
import { localParts } from "../time";
import { NEURON_GUARD } from "../workflow";
import { runTool, TOOLS } from "./tools";

const HISTORY = 12;
const MAX_TOOL_ROUNDS = 4;
const MAX_TOKENS = 600;

export const FALLBACK = "Sorry, I don't have an answer for that.";
export const LIMIT_TEXT = "Daily chat limit reached; it resets tomorrow.";
export const NEURONS_TEXT = "Today's AI allowance is nearly used up; ask again after 08:00 Malaysia time.";
export const BUSY_TEXT = "The AI is busy right now; try again in a minute.";
const FINAL_ASK = "Answer my question now, using only the tool results above. Don't call more tools.";

const SYSTEM = `You are the owner's personal stock assistant in Telegram, a candid and concise advisor.
- You can see their moomoo holdings and the plans and analyses this bot made, through your tools. Use the tools
  whenever the answer depends on their positions, prices, plans or news; never invent prices or figures.
- You cannot place, change or cancel orders. The owner trades themselves in the moomoo app; say so if asked.
- To analyse a stock, use queue_analysis. It runs in the background for a few minutes and the plan is sent as its
  own message; tell the owner when it will run.
- Only US stocks are supported for now.
- Keep answers short: a few sentences or a short list. Plain text, no markdown tables.
- This is information, not financial advice; mention it only when the owner asks what to do with money.`;

const asMessage = (m: { role: string; text: string }): ChatMessage =>
  m.role === "user" ? { role: "user", content: m.text }
    : { role: "assistant", content: m.role === "alert" ? `[Bot alert] ${m.text}` : m.text };

export async function chatReply(env: Env, store: Store, text: string, quoted: string | null, now: Date): Promise<string> {
  const today = localParts(now, env.OWNER_TZ).date;
  if ((await store.countChatOn(today, env.OWNER_TZ)) >= (Number(env.CHAT_MAX_PER_DAY ?? 30) || 30)) return LIMIT_TEXT;
  if ((await neuronsToday(store, env, now)) >= NEURON_GUARD) return NEURONS_TEXT;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    ...(await store.recentChat(HISTORY)).map(asMessage),
    { role: "user", content: quoted ? `[Replying to: ${quoted}]\n${text}` : text },
  ];
  await store.logChat("user", text, now);
  const model = env.DEEP_MODEL || DEFAULT_DEEP_MODEL;

  let answer = "";
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const lastRound = round === MAX_TOOL_ROUNDS;
      if (lastRound) messages.push({ role: "user", content: FINAL_ASK });
      const out = await askWithTools(env, store, model, messages, lastRound ? [] : TOOLS, MAX_TOKENS, now);
      if (!out.toolCalls.length || lastRound) {
        answer = out.text;
        break;
      }
      // Tool results go back as plain text: works with any model, no provider-specific tool-message format.
      const results = await Promise.all(out.toolCalls.map(async (c) =>
        `${c.name}(${JSON.stringify(c.arguments)}): ${await runTool(env, store, c.name, c.arguments, now)}`));
      messages.push({ role: "assistant", content: out.text || `Looking up: ${out.toolCalls.map((c) => c.name).join(", ")}` });
      messages.push({ role: "user", content: `Tool results:\n${results.join("\n")}` });
    }
  } catch (e) {
    if (e instanceof AiRateLimited) return BUSY_TEXT;
    console.error("chat failed", e instanceof Error ? e.name : typeof e);
    return `Sorry, that didn't work (${e instanceof Error ? e.name : "error"}). Please try again.`;
  }
  answer = answer.trim() || FALLBACK;
  await store.logChat("bot", answer, now);
  return answer;
}
