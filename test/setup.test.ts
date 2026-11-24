import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { clientId } from "../src/moomoo/oauth";
import { ensureSetup } from "../src/setup";
import { Store } from "../src/store";
import { type Call, json, mockFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-24T03:00:00Z");
const URL_ = "https://stock-agent.example.workers.dev";
const plusMin = (m: number) => new Date(NOW.getTime() + m * 60_000);
// A fresh deploy: address known, no webhook secret or moomoo client configured yet.
const fresh = (over: Partial<Env> = {}): Env =>
  ({ ...env, PUBLIC_URL: URL_, TELEGRAM_WEBHOOK_SECRET: undefined, MOOMOO_CLIENT_ID: undefined, ...over }) as Env;

let telegramUp = true;
function services(url: string) {
  if (url.startsWith("https://api.telegram.org/")) return telegramUp ? json({ ok: true, result: true }) : json({ ok: false }, 500);
  if (url.endsWith("/oauth2/register")) return json({ client_id: "registered-client", pkce_required: true });
  return undefined;
}
const named = (calls: Call[], method: string) => calls.filter((c) => c.url.endsWith(`/${method}`));

describe("ensureSetup", () => {
  it("does nothing without PUBLIC_URL", async () => {
    const calls = mockFetch(services);
    await ensureSetup(fresh({ PUBLIC_URL: "" }), new Store(env.DB), NOW);
    expect(calls).toEqual([]);
  });

  it("registers the webhook with a generated secret and the command menu, once", async () => {
    telegramUp = true;
    const store = new Store(env.DB);
    const calls = mockFetch(services);
    await ensureSetup(fresh(), store, NOW);
    const [hook] = named(calls, "setWebhook");
    const body = JSON.parse(hook!.body);
    expect(body.url).toBe(`${URL_}/telegram`);
    expect(body.secret_token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.secret_token).toBe(await store.getSetting("telegram_webhook_secret"));
    expect(named(calls, "setMyCommands")).toHaveLength(1);
    await ensureSetup(fresh(), store, plusMin(1));
    expect(named(calls, "setWebhook")).toHaveLength(1);
  });

  it("uses a configured webhook secret instead of generating one", async () => {
    telegramUp = true;
    const calls = mockFetch(services);
    await ensureSetup(fresh({ TELEGRAM_WEBHOOK_SECRET: "configured-secret" }), new Store(env.DB), NOW);
    expect(JSON.parse(named(calls, "setWebhook")[0]!.body).secret_token).toBe("configured-secret");
  });

  it("re-registers when the address changes", async () => {
    telegramUp = true;
    const store = new Store(env.DB);
    const calls = mockFetch(services);
    await ensureSetup(fresh(), store, NOW);
    await ensureSetup(fresh({ PUBLIC_URL: "https://bot.example.com/" }), store, plusMin(1));
    const hooks = named(calls, "setWebhook").map((c) => JSON.parse(c.body).url);
    expect(hooks).toEqual([`${URL_}/telegram`, "https://bot.example.com/telegram"]);
  });

  it("retries a failed webhook registration hourly, not every minute", async () => {
    telegramUp = false;
    const store = new Store(env.DB);
    const calls = mockFetch(services);
    await ensureSetup(fresh(), store, NOW);
    await ensureSetup(fresh(), store, plusMin(1));
    expect(named(calls, "setWebhook")).toHaveLength(1);
    telegramUp = true;
    await ensureSetup(fresh(), store, plusMin(61));
    expect(named(calls, "setWebhook")).toHaveLength(2);
    await ensureSetup(fresh(), store, plusMin(62));
    expect(named(calls, "setWebhook")).toHaveLength(2);
  });

  it("registers a moomoo client for the Worker's callback when none is configured", async () => {
    telegramUp = true;
    const store = new Store(env.DB);
    const calls = mockFetch(services);
    await ensureSetup(fresh(), store, NOW);
    const [reg] = named(calls, "register");
    expect(JSON.parse(reg!.body).redirect_uris).toEqual([`${URL_}/moomoo/callback`]);
    expect(await clientId(fresh(), store)).toBe("registered-client");
    await ensureSetup(fresh(), store, plusMin(1));
    expect(named(calls, "register")).toHaveLength(1);
  });

  it("registers its own moomoo client once a configured one is removed", async () => {
    telegramUp = true;
    const store = new Store(env.DB);
    const calls = mockFetch(services);
    await ensureSetup(fresh({ MOOMOO_CLIENT_ID: "manual-with-wrong-redirect" }), store, NOW);
    expect(named(calls, "register")).toEqual([]);
    await ensureSetup(fresh(), store, plusMin(1)); // owner deleted the MOOMOO_CLIENT_ID secret
    expect(named(calls, "register")).toHaveLength(1);
    expect(await clientId(fresh(), store)).toBe("registered-client");
  });

  it("keeps a configured moomoo client id", async () => {
    telegramUp = true;
    const calls = mockFetch(services);
    await ensureSetup(fresh({ MOOMOO_CLIENT_ID: "mine" }), new Store(env.DB), NOW);
    expect(named(calls, "register")).toEqual([]);
  });
});

describe("webhook secret check", () => {
  it("accepts the generated secret once setup stored it", async () => {
    telegramUp = true;
    const store = new Store(env.DB);
    mockFetch(services);
    await ensureSetup(fresh(), store, NOW);
    const secret = (await store.getSetting("telegram_webhook_secret"))!;
    const { webhookSecret } = await import("../src/telegram");
    expect(await webhookSecret(fresh(), store)).toBe(secret);
    // The deployed env in tests has a configured secret, which wins over the stored one.
    const res = await exports.default.fetch("https://worker.test/telegram", {
      method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
