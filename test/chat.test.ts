import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatReply, FALLBACK, LIMIT_TEXT, NEURONS_TEXT, BUSY_TEXT } from "../src/chat/engine";
import { handleUpdate } from "../src/commands";
import type { Env } from "../src/env";
import { Store } from "../src/store";
import { mockFetch, sentTexts, telegramOk } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-24T03:00:00Z");
type Msg = { role: string; content: string };

/** A fake Workers AI that plays back scripted answers: a tool request ({tool, args}) or a text. */
function scripted(...answers: ({ tool: string; args?: Record<string, unknown> } | string | Error)[]) {
  const calls: { messages: Msg[]; tools: unknown[] | undefined }[] = [];
  const run = vi.fn(async (_model: string, input: { messages: Msg[]; tools?: unknown[] }) => {
    calls.push({ messages: input.messages.map((m) => ({ ...m })), tools: input.tools });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return typeof a === "string" ? { response: a, usage: {} }
      : { response: null, tool_calls: [{ name: a.tool, arguments: a.args ?? {} }], usage: {} };
  });
  return { e: { ...env, AI: { run } as unknown as Ai, CHAT_MAX_PER_DAY: "30" } as Env, calls };
}

describe("chatReply", () => {
  it("queues an analysis through a tool call, then answers", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r");
    await store.setSetting("moomoo_access", "tok");
    await store.setSetting("moomoo_access_until", "2026-12-31T00:00:00Z");
    mockFetch(() => Response.json({ ret_code: 0, data: { snapshot_list: [{ code: "US.MDB", last_price: 316 }] } }));
    const { e, calls } = scripted({ tool: "queue_analysis", args: { ticker: "MDB" } }, "Queued MDB; the plan comes in a few minutes.");
    expect(await chatReply(e, store, "analyze MDB", null, NOW)).toBe("Queued MDB; the plan comes in a few minutes.");
    expect((await store.pendingItems()).map((i) => i.code)).toEqual(["US.MDB"]);
    expect(calls[1]!.messages.at(-1)!.content).toContain("Tool results:");
    expect(calls[1]!.messages.at(-1)!.content).toContain("queue_analysis");
  });

  it("stops a model that keeps calling tools and asks once for a final answer", async () => {
    const { e, calls } = scripted({ tool: "list_plans" }, { tool: "list_plans" }, { tool: "list_plans" },
      { tool: "list_plans" }, "Here is what I found.");
    expect(await chatReply(e, new Store(env.DB), "plans?", null, NOW)).toBe("Here is what I found.");
    expect(calls).toHaveLength(5);
    expect(calls[4]!.tools).toBeUndefined(); // the final call offers no tools
  });

  it("never answers with silence", async () => {
    const { e } = scripted("   ");
    expect(await chatReply(e, new Store(env.DB), "hi", null, NOW)).toBe(FALLBACK);
  });

  it("stops at the daily chat limit without calling the AI", async () => {
    const store = new Store(env.DB);
    const { e, calls } = scripted("ok");
    for (let i = 0; i < 30; i++) await store.logChat("user", `q${i}`, NOW);
    expect(await chatReply(e, store, "one more", null, NOW)).toBe(LIMIT_TEXT);
    expect(calls).toHaveLength(0);
  });

  it("stops when today's neurons are nearly used up", async () => {
    const store = new Store(env.DB);
    await store.setSetting("neurons:2026-11-24", "9100");
    const { e, calls } = scripted("ok");
    expect(await chatReply(e, store, "hi", null, NOW)).toBe(NEURONS_TEXT);
    expect(calls).toHaveLength(0);
  });

  it("says the AI is busy on a rate limit", async () => {
    const { e } = scripted(new Error("3040: Capacity temporarily exceeded"));
    expect(await chatReply(e, new Store(env.DB), "hi", null, NOW)).toBe(BUSY_TEXT);
  });

  it("includes the message being replied to", async () => {
    const { e, calls } = scripted("ok");
    await chatReply(e, new Store(env.DB), "why?", "⚠️ Stop-loss: US.MDB at 279.00", NOW);
    expect(calls[0]!.messages.at(-1)!.content).toBe("[Replying to: ⚠️ Stop-loss: US.MDB at 279.00]\nwhy?");
  });

  it("remembers the last 12 messages, alerts included", async () => {
    const store = new Store(env.DB);
    for (let i = 0; i < 20; i++) await store.logChat(i % 2 ? "bot" : "user", `m${i}`, NOW);
    await store.logChat("alert", "⚠️ Stop-loss: US.MDB", NOW);
    const { e, calls } = scripted("ok");
    await chatReply(e, store, "hello", null, NOW);
    const history = calls[0]!.messages.slice(1, -1); // between the system prompt and the new message
    expect(history).toHaveLength(12);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "[Bot alert] ⚠️ Stop-loss: US.MDB" });
    expect((await store.recentChat(2)).map((m) => m.text)).toEqual(["hello", "ok"]);
  });
});

describe("chat in Telegram", () => {
  it("answers plain text through the chat, showing typing first", async () => {
    const { e } = scripted("Hi! Ask me about your holdings.");
    const calls = mockFetch(telegramOk);
    await handleUpdate(e, new Store(env.DB), { message: { chat: { id: 1001 }, text: "hi" } }, NOW, "https://worker.test");
    expect(calls[0]!.url).toContain("/sendChatAction");
    expect(sentTexts(calls)).toEqual(["Hi! Ask me about your holdings."]);
  });

  it("passes the quoted bot message along", async () => {
    const { e, calls: ai } = scripted("Because the stop was hit.");
    mockFetch(telegramOk);
    await handleUpdate(e, new Store(env.DB), {
      message: { chat: { id: 1001 }, text: "why?", reply_to_message: { text: "⚠️ Stop-loss: US.MDB" } },
    }, NOW, "https://worker.test");
    expect(ai[0]!.messages.at(-1)!.content).toContain("[Replying to: ⚠️ Stop-loss: US.MDB]");
  });
});

describe("chat safety limits", () => {
  it("runs at most 3 tools per round and queues at most one analysis per message", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r");
    await store.setSetting("moomoo_access", "tok");
    await store.setSetting("moomoo_access_until", "2026-12-31T00:00:00Z");
    mockFetch((url) => (url.endsWith("/quote/snapshot")
      ? Response.json({ ret_code: 0, data: { snapshot_list: [{ code: "US.MDB", last_price: 316 }, { code: "US.NVDA", last_price: 165 }] } })
      : undefined));
    let n = 0;
    const run = vi.fn(async (_m: string, input: { messages: Msg[] }) => {
      n++;
      if (n === 1) {
        return { response: null, usage: {}, tool_calls: [
          { name: "queue_analysis", arguments: { ticker: "MDB" } }, { name: "queue_analysis", arguments: { ticker: "NVDA" } },
          { name: "list_plans", arguments: {} }, { name: "list_plans", arguments: {} }, { name: "list_plans", arguments: {} },
        ] };
      }
      const results = input.messages.at(-1)!.content;
      expect(results.match(/^\w+\(/gm)).toHaveLength(3); // only 3 of the 5 requested tools ran
      expect(results).toContain("one analysis per message");
      return { response: "Queued MDB.", usage: {} };
    });
    const e = { ...env, AI: { run } as unknown as Ai, CHAT_MAX_PER_DAY: "30" } as Env;
    expect(await chatReply(e, store, "analyze MDB and NVDA", null, NOW)).toBe("Queued MDB.");
    expect((await store.pendingItems()).map((i) => i.code)).toEqual(["US.MDB"]);
  });

  it("answers a Telegram update only once, even if Telegram delivers it twice", async () => {
    const { e, calls: ai } = scripted("Hello!");
    const sent = mockFetch(telegramOk);
    const update = { update_id: 777, message: { chat: { id: 1001 }, text: "hi" } };
    await handleUpdate(e, new Store(env.DB), update, NOW, "https://worker.test");
    await handleUpdate(e, new Store(env.DB), update, NOW, "https://worker.test");
    expect(sentTexts(sent)).toEqual(["Hello!"]);
    expect(ai).toHaveLength(1);
  });
});
