import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessToken, connectUrl, handleCallback, isAcceptable, MoomooUnavailable } from "../src/moomoo/oauth";
import { Store } from "../src/store";
import { json, mockFetch, sentTexts, telegramOk } from "./helpers";

const NOW = new Date("2026-11-24T03:00:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

afterEach(() => vi.restoreAllMocks());

function tokenRoute(body: unknown, status = 200) {
  return (url: string) => telegramOk(url) ?? (url.endsWith("/oauth2/token") ? json(body, status) : undefined);
}

async function startConnect(store: Store) {
  const url = new URL(await connectUrl(env, store, "https://worker.test", NOW));
  return url.searchParams.get("state")!;
}

const callback = (state: string, code = "abc") =>
  new Request(`https://worker.test/moomoo/callback?state=${state}&code=${code}`);

describe("scope rules", () => {
  it("keeps only read-only grants that include quotes", () => {
    expect(isAcceptable("trade:read quote:read")).toBe(true);
    expect(isAcceptable("trade:read quote:read trade:write")).toBe(false);
    expect(isAcceptable("trade:read")).toBe(false);
  });
});

describe("callback", () => {
  it("rejects a wrong state and stores nothing", async () => {
    const store = new Store(env.DB);
    mockFetch(tokenRoute({ access_token: "a", refresh_token: "r", scope: "trade:read quote:read" }));
    await startConnect(store);
    const res = await handleCallback(callback("wrong"), env, store, NOW);
    expect(await res.text()).toContain("Link expired");
    expect(await store.getSetting("moomoo_refresh")).toBeNull();
  });

  it("rejects a late callback", async () => {
    const store = new Store(env.DB);
    mockFetch(tokenRoute({ access_token: "a", refresh_token: "r", scope: "trade:read quote:read" }));
    const state = await startConnect(store);
    const res = await handleCallback(callback(state), env, store, later(16));
    expect(await res.text()).toContain("Link expired");
    expect(await store.getSetting("moomoo_refresh")).toBeNull();
  });

  it("discards a grant that can trade and tells the owner", async () => {
    const store = new Store(env.DB);
    const calls = mockFetch(tokenRoute({ access_token: "a", refresh_token: "r", scope: "trade:read trade:write quote:read" }));
    const state = await startConnect(store);
    await handleCallback(callback(state), env, store, NOW);
    expect(await store.getSetting("moomoo_refresh")).toBeNull();
    expect(sentTexts(calls).join("\n")).toContain("permission to trade");
  });

  it("stores a read-only grant once, and the link is single-use", async () => {
    const store = new Store(env.DB);
    mockFetch(tokenRoute({ access_token: "a", refresh_token: "r1", scope: "trade:read quote:read", expires_in: 7200 }));
    const state = await startConnect(store);
    await handleCallback(callback(state), env, store, NOW);
    expect(await store.getSetting("moomoo_refresh")).toBe("r1");
    expect(await store.getSetting("moomoo_until")).toBe("2026-12-08");
    const again = await handleCallback(callback(state), env, store, NOW);
    expect(await again.text()).toContain("Link expired");
  });
});

describe("accessToken", () => {
  it("returns null when not connected", async () => {
    mockFetch(() => undefined);
    expect(await accessToken(env, new Store(env.DB), NOW)).toBeNull();
  });

  it("reuses a cached token and refreshes near expiry", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r1");
    const calls = mockFetch(tokenRoute({ access_token: "fresh", scope: "trade:read quote:read", expires_in: 7200 }));
    expect(await accessToken(env, store, NOW)).toBe("fresh");
    expect(await accessToken(env, store, later(60))).toBe("fresh");
    expect(calls.filter((c) => c.url.endsWith("/oauth2/token"))).toHaveLength(1);
    await accessToken(env, store, later(116));
    expect(calls.filter((c) => c.url.endsWith("/oauth2/token"))).toHaveLength(2);
  });

  it("clears an expired connection and says so once", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r1");
    const calls = mockFetch(tokenRoute({ error: "invalid_grant" }, 400));
    expect(await accessToken(env, store, NOW)).toBeNull();
    expect(await accessToken(env, store, NOW)).toBeNull();
    expect(await store.getSetting("moomoo_refresh")).toBeNull();
    expect(sentTexts(calls)).toEqual(["Your moomoo connection has expired. Send /moomoo to reconnect."]);
  });

  it("keeps the connection when moomoo is down", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r1");
    mockFetch(tokenRoute({}, 503));
    await expect(accessToken(env, store, NOW)).rejects.toBeInstanceOf(MoomooUnavailable);
    expect(await store.getSetting("moomoo_refresh")).toBe("r1");
  });

  it("keeps the connection on an unexpected answer (firewall, maintenance page)", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r1");
    mockFetch((url) => telegramOk(url) ?? (url.endsWith("/oauth2/token") ? new Response("<html>maintenance</html>") : undefined));
    await expect(accessToken(env, store, NOW)).rejects.toBeInstanceOf(MoomooUnavailable);
    mockFetch(tokenRoute({ error: "forbidden" }, 403));
    await expect(accessToken(env, store, NOW)).rejects.toBeInstanceOf(MoomooUnavailable);
    expect(await store.getSetting("moomoo_refresh")).toBe("r1");
  });

  it("treats a 401 as an expired connection", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r1");
    mockFetch(tokenRoute({}, 401));
    expect(await accessToken(env, store, NOW)).toBeNull();
    expect(await store.getSetting("moomoo_refresh")).toBeNull();
  });

  it("keeps a rotated refresh token and its new expiry", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r1");
    mockFetch(tokenRoute({ access_token: "a2", refresh_token: "r2", refresh_token_expires_in: 30 * 86400,
      scope: "trade:read quote:read", expires_in: 7200 }));
    expect(await accessToken(env, store, NOW)).toBe("a2");
    expect(await store.getSetting("moomoo_refresh")).toBe("r2");
    expect(await store.getSetting("moomoo_until")).toBe("2026-12-24");
  });

  it("drops a refreshed token that can trade", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r1");
    mockFetch(tokenRoute({ access_token: "x", scope: "trade:read trade:write quote:read", expires_in: 7200 }));
    expect(await accessToken(env, store, NOW)).toBeNull();
    expect(await store.getSetting("moomoo_refresh")).toBeNull();
  });
});

describe("/moomoo commands", () => {
  const upd = (text: string) => ({ message: { chat: { id: 1001 }, text } });

  it("offers a read-only connect button when not connected", async () => {
    const { handleUpdate } = await import("../src/commands");
    const calls = mockFetch(telegramOk);
    await handleUpdate(env, new Store(env.DB), upd("/moomoo"), NOW, "https://worker.test");
    const body = JSON.parse(calls.find((c) => c.url.includes("/sendMessage"))!.body);
    expect(body.text).toContain("leave trading OFF");
    expect(body.reply_markup.inline_keyboard[0][0].url).toContain("/oauth2/authorize/confirm");
  });

  it("shows the link state when connected, and /moomoo off disconnects", async () => {
    const { handleUpdate } = await import("../src/commands");
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r1");
    await store.setSetting("moomoo_until", "2026-12-08");
    const calls = mockFetch(telegramOk);
    await handleUpdate(env, store, upd("/moomoo"), NOW, "https://worker.test");
    expect(sentTexts(calls)[0]).toContain("connected, read-only");
    await handleUpdate(env, store, upd("/moomoo off"), NOW, "https://worker.test");
    expect(await store.getSetting("moomoo_refresh")).toBeNull();
  });

  it("routes the browser callback", async () => {
    const { exports } = await import("cloudflare:workers");
    mockFetch(telegramOk);
    const res = await exports.default.fetch("https://worker.test/moomoo/callback?state=x&code=y");
    expect(await res.text()).toContain("Link expired");
  });
});
