/**
 * Self-setup after a deploy: register the Telegram webhook and command menu, and a moomoo OAuth client, for the
 * address in PUBLIC_URL. Each part runs once per address; a failed part is retried at most once an hour.
 */
import { COMMANDS } from "./commands";
import type { Env } from "./env";
import { CALLBACK_PATH, clientId, registerClient } from "./moomoo/oauth";
import type { Store } from "./store";
import { send, telegramApi, webhookSecret } from "./telegram";

/** Bump to make every deployed Worker redo its setup (e.g. after changing the command list or webhook options). */
const SETUP_VERSION = 1;

const hour = (now: Date) => now.toISOString().slice(0, 13);

async function setupTelegram(env: Env, store: Store, url: string): Promise<boolean> {
  const hooked = await telegramApi(env, "setWebhook", {
    url: `${url}/telegram`,
    secret_token: await webhookSecret(env, store),
    allowed_updates: ["message"],
  });
  const menu = await telegramApi(env, "setMyCommands", {
    commands: COMMANDS.map(([command, description]) => ({ command, description })),
  });
  return hooked && menu;
}

async function setupMoomoo(env: Env, store: Store, url: string): Promise<void> {
  if (env.MOOMOO_CLIENT_ID) return; // configured by hand
  if ((await clientId(env, store)) && (await store.getSetting("moomoo_client_for")) === url) return;
  // A client is tied to its redirect address, so a new address needs a new client (and a fresh /moomoo sign-in).
  await store.setSetting("moomoo_client_id", await registerClient(url + CALLBACK_PATH));
  await store.setSetting("moomoo_client_for", url);
  await send(env, "moomoo app registered for this bot. Send /moomoo to connect read-only.");
}

export async function ensureSetup(env: Env, store: Store, now: Date): Promise<void> {
  const url = (env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) return;
  const done = `${SETUP_VERSION}|${url}`;

  if ((await store.getSetting("setup_telegram")) !== done && (await store.markOnce(`setup_try:telegram:${url}:${hour(now)}`, now))) {
    if (await setupTelegram(env, store, url)) await store.setSetting("setup_telegram", done);
  }
  if ((await store.getSetting("setup_moomoo")) !== done && (await store.markOnce(`setup_try:moomoo:${url}:${hour(now)}`, now))) {
    try {
      await setupMoomoo(env, store, url);
      await store.setSetting("setup_moomoo", done);
    } catch (e) {
      console.error("moomoo client registration failed", e instanceof Error ? e.name : typeof e);
    }
  }
}
