/**
 * Read-only link to the owner's moomoo account (OAuth 2 with PKCE).
 * A grant that can place orders is thrown away, never stored.
 */
import type { Env } from "../env";
import type { Store } from "../store";
import { send } from "../telegram";
import { localParts } from "../time";

export const MOOMOO_API = "https://webapi.moomoo.com";
export const CALLBACK_PATH = "/moomoo/callback";
const STATE_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const DEFAULT_LIFE_DAYS = 14; // moomoo's default refresh-token lifetime
const EXPIRED_TEXT = "Your moomoo connection has expired. Send /moomoo to reconnect.";
const KEYS = ["moomoo_refresh", "moomoo_scope", "moomoo_until", "moomoo_access", "moomoo_access_until"];

/** moomoo is having trouble; the stored approval is still good. */
export class MoomooUnavailable extends Error {}

const words = (scope: string) => scope.split(/\s+/);
export const canTrade = (scope: string) => words(scope).includes("trade:write");
export const isAcceptable = (scope: string) =>
  !canTrade(scope) && words(scope).includes("trade:read") && words(scope).includes("quote:read");

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const challengeOf = async (verifier: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

interface TokenResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResult> {
  const res = await fetch(`${MOOMOO_API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.MOOMOO_CLIENT_ID ?? "", ...params }).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { ok: res.ok && typeof body.access_token === "string", status: res.status, body };
}

async function clear(store: Store): Promise<void> {
  for (const key of KEYS) await store.setSetting(key, "");
}

async function saveAccess(store: Store, body: Record<string, unknown>, now: Date): Promise<string> {
  const seconds = Number(body.expires_in) || 7200;
  await store.setSetting("moomoo_access", String(body.access_token));
  await store.setSetting("moomoo_access_until", new Date(now.getTime() + seconds * 1000).toISOString());
  return String(body.access_token);
}

/** Starts a connection: remembers a one-time state and returns moomoo's consent URL. */
export async function connectUrl(env: Env, store: Store, origin: string, now: Date): Promise<string> {
  const verifier = random(48);
  const state = random(24);
  await store.setSetting("moomoo_pending", JSON.stringify({ state, verifier, at: now.getTime() }));
  return `${MOOMOO_API}/oauth2/authorize/confirm?${new URLSearchParams({
    client_id: env.MOOMOO_CLIENT_ID ?? "",
    code_challenge: await challengeOf(verifier),
    code_challenge_method: "S256",
    redirect_uri: origin + CALLBACK_PATH,
    response_type: "code",
    state,
  })}`;
}

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h2>${title}</h2><p>${body}</p></body>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

/** moomoo sends the owner's browser back here after the consent screen. */
export async function handleCallback(req: Request, env: Env, store: Store, now: Date): Promise<Response> {
  const url = new URL(req.url);
  const pending = JSON.parse((await store.getSetting("moomoo_pending")) ?? "null") as
    { state: string; verifier: string; at: number } | null;
  await store.setSetting("moomoo_pending", ""); // one use only, whatever happens next
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!pending || state !== pending.state || now.getTime() - pending.at > STATE_MS) {
    return page("Link expired", "This connect link is no longer valid. Send /moomoo to the bot for a new one.");
  }
  if (!code) {
    await send(env, "moomoo wasn't connected: the approval was cancelled. Send /moomoo to try again.");
    return page("Not connected", "The approval was cancelled. You can close this page.");
  }
  const { ok, body } = await tokenRequest(env, {
    grant_type: "authorization_code", code, redirect_uri: url.origin + CALLBACK_PATH, code_verifier: pending.verifier,
  });
  if (!ok || typeof body.refresh_token !== "string") {
    await send(env, "moomoo didn't complete the connection. Nothing was stored. Send /moomoo to try again.");
    return page("Not connected", "moomoo did not complete the connection. Go back to Telegram and try again.");
  }
  const scope = String(body.scope ?? "");
  if (!isAcceptable(scope)) {
    const why = canTrade(scope) ? "it included permission to trade" : "it did not include reading positions and quotes";
    await send(env, `I did not keep the moomoo access, because ${why}. Nothing is stored.\n\n` +
      "Send /moomoo and try again: allow reading positions and quotes, and leave trading OFF.");
    return page("Not connected", `The access was discarded because ${why}. Go back to Telegram for the next step.`);
  }
  const seconds = Number(body.refresh_token_expires_in);
  const days = Number.isFinite(seconds) && seconds > 0 ? seconds / 86400 : DEFAULT_LIFE_DAYS;
  await store.setSetting("moomoo_refresh", body.refresh_token);
  await store.setSetting("moomoo_scope", scope);
  await store.setSetting("moomoo_until", localParts(new Date(now.getTime() + days * 86_400_000), env.OWNER_TZ).date);
  await saveAccess(store, body, now);
  await send(env, "moomoo connected, read-only. Send /moomoo sync to sync your positions now.");
  return page("Connected", "moomoo is connected, read-only. You can close this page and go back to Telegram.");
}

/**
 * A valid access token, refreshed when it has under 5 minutes left. Null when not connected (or the connection just
 * expired, which the owner is told once). Throws MoomooUnavailable when moomoo itself fails.
 */
export async function accessToken(env: Env, store: Store, now: Date): Promise<string | null> {
  const refresh = await store.getSetting("moomoo_refresh");
  if (!refresh) return null;
  const cached = await store.getSetting("moomoo_access");
  const until = await store.getSetting("moomoo_access_until");
  if (cached && until && new Date(until).getTime() - now.getTime() > REFRESH_MARGIN_MS) return cached;

  const { ok, status, body } = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refresh });
  if (!ok && (status >= 500 || status === 429)) throw new MoomooUnavailable(`moomoo token endpoint answered ${status}`);
  if (!ok) {
    await clear(store);
    await send(env, EXPIRED_TEXT);
    return null;
  }
  if (canTrade(String(body.scope ?? ""))) {
    await clear(store);
    await send(env, "moomoo returned an access that can trade, so I deleted the connection. " +
      "Send /moomoo to reconnect with trading switched off.");
    return null;
  }
  return saveAccess(store, body, now);
}

export async function disconnect(store: Store): Promise<void> {
  await clear(store);
}
