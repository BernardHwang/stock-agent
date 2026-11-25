import type { Env } from "./env";
import type { Store } from "./store";

export type Button = { text: string; url: string };

export interface Update {
  update_id?: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string; reply_to_message?: { text?: string } };
}

const LIMIT = 4000;
const SOURCE_LIMIT = 3500; // pieces are split before HTML escaping, which lengthens them

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Light markdown (**bold**, `code`, # headings, * or - bullets) to Telegram HTML; everything else is escaped.
 * Line by line, so a piece split at line breaks never leaves a tag open.
 */
export function toTelegramHtml(text: string): string {
  return text.split("\n").map((line) => {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) return `<b>${escapeHtml(heading[1]!.replace(/\*\*/g, ""))}</b>`;
    const bullet = line.replace(/^(\s*)[*-]\s+/, "$1• ");
    return bullet.split("`").map((part, i, all) => {
      if (i % 2 === 1 && i < all.length - 1) return `<code>${escapeHtml(part)}</code>`;
      const text = escapeHtml(i % 2 === 1 ? `\`${part}` : part); // an unpaired backtick stays literal
      return text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    }).join("");
  }).join("\n");
}

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

/** Message the owner; light markdown renders as HTML (see toTelegramHtml). Buttons go on the last piece. */
export async function send(env: Env, text: string, buttons?: Button[][]): Promise<void> {
  await trySend(env, text, buttons);
}

async function sendPiece(env: Env, body: Record<string, unknown>): Promise<Response | null> {
  try {
    return await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("telegram sendMessage failed", e instanceof Error ? e.name : typeof e);
    return null;
  }
}

/** Like send, but reports whether Telegram accepted every piece; never throws. */
export async function trySend(env: Env, text: string, buttons?: Button[][]): Promise<boolean> {
  const pieces = splitMessage(text, SOURCE_LIMIT);
  let delivered = true;
  for (const [i, piece] of pieces.entries()) {
    const base: Record<string, unknown> = { chat_id: env.OWNER_CHAT_ID, link_preview_options: { is_disabled: true } };
    if (buttons && i === pieces.length - 1) base.reply_markup = { inline_keyboard: buttons };
    let res = await sendPiece(env, { ...base, text: toTelegramHtml(piece), parse_mode: "HTML" });
    // 400 is Telegram refusing the HTML (e.g. "can't parse entities"): the plain text still gets through.
    if (res?.status === 400) res = await sendPiece(env, { ...base, text: piece });
    if (!res?.ok) {
      delivered = false;
      if (res) console.error(`telegram sendMessage failed: ${res.status}`); // never log the URL: it holds the token
    }
  }
  return delivered;
}

/** The webhook secret: the configured one, else one generated once and kept in D1. */
export async function webhookSecret(env: Env, store: Store): Promise<string> {
  if (env.TELEGRAM_WEBHOOK_SECRET) return env.TELEGRAM_WEBHOOK_SECRET;
  const stored = await store.getSetting("telegram_webhook_secret");
  if (stored) return stored;
  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await store.setSetting("telegram_webhook_secret", secret);
  return secret;
}

/** Call a Telegram Bot API method; true when Telegram answered ok. Never throws, never logs the token. */
export async function telegramApi(env: Env, method: string, body: object): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (!res.ok || !data.ok) console.error(`telegram ${method} failed: ${res.status}`);
    return res.ok && data.ok === true;
  } catch (e) {
    console.error(`telegram ${method} failed`, e instanceof Error ? e.name : typeof e);
    return false;
  }
}

/** Constant-time check of Telegram's webhook secret header. */
export function hasValidSecret(req: Request, secret: string): boolean {
  const given = new TextEncoder().encode(req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "");
  const expected = new TextEncoder().encode(secret);
  if (!secret || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given[i]! ^ expected[i]!;
  return diff === 0;
}
