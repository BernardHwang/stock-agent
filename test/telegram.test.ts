import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, handleUpdate } from "../src/commands";
import { Store } from "../src/store";
import { json, mockFetch, sentTexts, telegramOk } from "./helpers";
import { toTelegramHtml, trySend } from "../src/telegram";

const NOW = new Date("2026-11-24T03:00:00Z");
const update = (text: string, chatId = 1001) => ({ message: { chat: { id: chatId }, from: { id: chatId }, text } });

afterEach(() => vi.restoreAllMocks());

describe("webhook", () => {
  it("rejects a request without the secret header", async () => {
    const res = await exports.default.fetch("https://worker.test/telegram", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("ignores updates from other chats", async () => {
    const calls = mockFetch(telegramOk);
    const res = await exports.default.fetch("https://worker.test/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
      body: JSON.stringify(update("/help", 999)),
    });
    expect(res.status).toBe(200);
    expect(sentTexts(calls)).toEqual([]);
  });
});

describe("command center", () => {
  const send = async (text: string, store = new Store(env.DB)) => {
    const calls = mockFetch(telegramOk);
    await handleUpdate(env, store, update(text), NOW, "https://worker.test");
    return sentTexts(calls);
  };

  it("offers every feature as its own menu command", () => {
    expect(COMMANDS.map(([n]) => n)).toEqual(
      ["help", "status", "holdings", "sync", "moomoo", "reconnect", "disconnect", "probe", "aitest"]);
    for (const [name, description] of COMMANDS) {
      expect(name).toMatch(/^[a-z0-9_]{1,32}$/); // Telegram's rule for menu commands
      expect(description.length).toBeGreaterThanOrEqual(3);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });

  it("/help explains usage and what runs automatically", async () => {
    const [text] = await send("/help");
    expect(text).toContain("/probe [post] <path> [json]");
    expect(text).toContain("/aitest [model]");
    for (const part of ["Price alerts", "Morning brief", "Pre-open note", "Event notes", "Sunday review"]) expect(text).toContain(part);
  });

  it("/sync works like /moomoo sync", async () => {
    expect(await send("/sync")).toEqual(["moomoo isn't connected. Send /moomoo to connect."]);
  });

  it("/disconnect removes the stored access", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r");
    await send("/disconnect", store);
    expect(await store.getSetting("moomoo_refresh")).toBeNull();
  });

  it("/reconnect offers a fresh sign-in link", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r");
    const [text] = await send("/reconnect", store);
    expect(text).toContain("Sign in again");
  });

  it("/probe without a path explains its usage", async () => {
    const [text] = await send("/probe");
    expect(text).toContain("/api/v1.0/quote/");
  });
});

describe("commands", () => {
  it("lists every command in /help", async () => {
    const calls = mockFetch(telegramOk);
    await handleUpdate(env, new Store(env.DB), update("/help"), NOW, "https://worker.test");
    const [text] = sentTexts(calls);
    for (const [name] of COMMANDS) expect(text).toContain(`/${name}`);
  });

  it("answers an unknown command", async () => {
    const calls = mockFetch(telegramOk);
    await handleUpdate(env, new Store(env.DB), update("/foo"), NOW, "https://worker.test");
    expect(sentTexts(calls)).toEqual(["Unknown command. Send /help."]);
  });

  it("splits a long reply at line breaks", async () => {
    const calls = mockFetch(telegramOk);
    const store = new Store(env.DB);
    const many = Array.from({ length: 300 }, (_, i) => ({ code: `US.T${i}`, name: "x".repeat(10), qty: 1, avgCost: 1 }));
    await store.savePositions(many, NOW);
    await handleUpdate(env, store, update("/holdings"), NOW, "https://worker.test");
    const texts = sentTexts(calls);
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(4000);
  });
});

describe("HTML rendering", () => {
  it("turns light markdown into Telegram HTML and escapes the rest", () => {
    expect(toTelegramHtml("## Plan\n**Bold** & <tag> `a<b` 3*4\n* one\n- two")).toBe(
      "<b>Plan</b>\n<b>Bold</b> &amp; &lt;tag&gt; <code>a&lt;b</code> 3*4\n• one\n• two");
  });

  it("does not format inside code", () =>
    expect(toTelegramHtml("`**x**` **y**")).toBe("<code>**x**</code> <b>y</b>"));

  it("sends with parse_mode HTML", async () => {
    const calls = mockFetch(telegramOk);
    await trySend(env, "**hi** <there>");
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({ text: "<b>hi</b> &lt;there&gt;", parse_mode: "HTML" });
  });

  it("falls back to plain text when Telegram rejects the HTML", async () => {
    let first = true;
    const calls = mockFetch((url) => {
      if (!url.startsWith("https://api.telegram.org/")) return undefined;
      if (first) return (first = false), json({ ok: false, description: "can't parse entities" }, 400);
      return json({ ok: true });
    });
    expect(await trySend(env, "**hi**")).toBe(true);
    const retry = JSON.parse(calls[1]!.body);
    expect(retry.text).toBe("**hi**");
    expect(retry.parse_mode).toBeUndefined();
  });
});
