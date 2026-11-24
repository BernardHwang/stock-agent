import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, handleUpdate } from "../src/commands";
import { Store } from "../src/store";
import { mockFetch, sentTexts, telegramOk } from "./helpers";

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

describe("commands", () => {
  it("lists every command in /help", async () => {
    const calls = mockFetch(telegramOk);
    await handleUpdate(env, new Store(env.DB), update("/help"), NOW, "https://worker.test");
    const [text] = sentTexts(calls);
    for (const [name] of COMMANDS) expect(text).toContain(`/${name}`);
  });

  it("answers plain text with a pointer to the commands until chat exists", async () => {
    const calls = mockFetch(telegramOk);
    await handleUpdate(env, new Store(env.DB), update("hi"), NOW, "https://worker.test");
    expect(sentTexts(calls)).toEqual(["I only understand commands for now; chat is coming. Send /help to see them."]);
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
