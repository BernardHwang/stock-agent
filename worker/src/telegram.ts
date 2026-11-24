import type { Env } from "./env";

export type Button = { text: string; url: string };

export interface Update {
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
}

const LIMIT = 4000;

/** Split at line breaks into Telegram-sized pieces; a single over-long line is hard-cut. */
export function splitMessage(text: string, limit = LIMIT): string[] {
  const out: string[] = [];
  let current = "";
  for (let line of text.split("\n")) {
    while (line.length > limit) {
      if (current) out.push(current), (current = "");
      out.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) out.push(current), (current = line);
    else current = next;
  }
  if (current) out.push(current);
  return out;
}

/** Message the owner (plain text). Buttons go on the last piece. */
export async function send(env: Env, text: string, buttons?: Button[][]): Promise<void> {
  await trySend(env, text, buttons);
}

/** Like send, but reports whether Telegram accepted every piece; never throws. */
export async function trySend(env: Env, text: string, buttons?: Button[][]): Promise<boolean> {
  const pieces = splitMessage(text);
  let delivered = true;
  for (const [i, piece] of pieces.entries()) {
    const body: Record<string, unknown> = { chat_id: env.OWNER_CHAT_ID, text: piece, link_preview_options: { is_disabled: true } };
    if (buttons && i === pieces.length - 1) body.reply_markup = { inline_keyboard: buttons };
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        delivered = false;
        console.error(`telegram sendMessage failed: ${res.status}`); // never log the URL: it holds the token
      }
    } catch (e) {
      delivered = false;
      console.error("telegram sendMessage failed", e instanceof Error ? e.name : typeof e);
    }
  }
  return delivered;
}

/** Constant-time check of Telegram's webhook secret header. */
export function hasValidSecret(req: Request, env: Env): boolean {
  const given = new TextEncoder().encode(req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "");
  const expected = new TextEncoder().encode(env.TELEGRAM_WEBHOOK_SECRET);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given[i]! ^ expected[i]!;
  return diff === 0;
}
