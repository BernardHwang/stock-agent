import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { AiRateLimited, ask, askWithTools, neuronsToday } from "../src/ai";
import type { Env } from "../src/env";
import { Store } from "../src/store";

const NOW = new Date("2026-11-24T03:00:00Z");
const DEEP = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const withAi = (run: (...a: unknown[]) => unknown) => ({ ...env, AI: { run: vi.fn(run) } as unknown as Ai }) as Env;

describe("ask", () => {
  it("returns the text and adds the call's neurons to today's tally", async () => {
    const store = new Store(env.DB);
    const e = withAi(async () => ({ response: "hello", usage: { prompt_tokens: 3000, completion_tokens: 500 } }));
    expect(await ask(e, store, DEEP, "system", "user", 300, NOW)).toBe("hello");
    expect(await neuronsToday(store, e, NOW)).toBeCloseTo(182.4, 1);
    await ask(e, store, DEEP, "system", "user", 300, NOW);
    expect(await neuronsToday(store, e, NOW)).toBeCloseTo(364.8, 1);
  });

  it("sends the system and user messages and the token limit", async () => {
    const e = withAi(async () => ({ response: "ok" }));
    await ask(e, new Store(env.DB), DEEP, "be brief", "hi", 123, NOW);
    expect(e.AI.run).toHaveBeenCalledWith(DEEP, {
      messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], max_tokens: 123,
    });
  });

  it("turns capacity and quota refusals into AiRateLimited", async () => {
    for (const message of ["3040: Capacity temporarily exceeded, please try again.", "AiError: 3036: daily free allocation",
      "429 Too Many Requests"]) {
      const e = withAi(async () => { throw new Error(message); });
      await expect(ask(e, new Store(env.DB), DEEP, "s", "u", 10, NOW)).rejects.toBeInstanceOf(AiRateLimited);
    }
  });

  it("passes other errors through", async () => {
    const e = withAi(async () => { throw new Error("5007: No such model"); });
    const err = await ask(e, new Store(env.DB), DEEP, "s", "u", 10, NOW).catch((x) => x);
    expect(err).not.toBeInstanceOf(AiRateLimited);
    expect(String(err)).toContain("5007");
  });
});

describe("askWithTools", () => {
  it("returns tool calls with parsed arguments", async () => {
    const e = withAi(async () => ({
      response: null,
      tool_calls: [{ name: "get_quote", arguments: { ticker: "MDB" } }, { name: "list_plans", arguments: "{}" }],
    }));
    const out = await askWithTools(e, new Store(env.DB), DEEP, [{ role: "user", content: "hi" }], [], 200, NOW);
    expect(out).toEqual({ text: "", toolCalls: [{ name: "get_quote", arguments: { ticker: "MDB" } }, { name: "list_plans", arguments: {} }] });
  });
});
