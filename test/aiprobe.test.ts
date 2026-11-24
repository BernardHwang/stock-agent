import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiProbe, estimateNeurons } from "../src/aiprobe";
import { handleUpdate } from "../src/commands";
import { Store } from "../src/store";
import { mockFetch, sentTexts, telegramOk } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const fakeAi = (usage = { prompt_tokens: 3000, completion_tokens: 500 }) =>
  ({ run: vi.fn(async () => ({ response: "x", usage })) }) as unknown as Ai;

describe("aiProbe", () => {
  it("reads the token usage of one call", async () => {
    const ai = fakeAi();
    const out = await aiProbe(ai, MODEL);
    expect(out).toMatchObject({ promptTokens: 3000, completionTokens: 500 });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("estimates neurons from Cloudflare's per-model rates", () => {
    // 3000 * 26668 / 1e6 + 500 * 204805 / 1e6 = 80.0 + 102.4
    expect(estimateNeurons(MODEL, 3000, 500)).toBeCloseTo(182.4, 1);
    expect(estimateNeurons("@cf/unknown/model", 1, 1)).toBeNull();
  });

  it("/aitest reports tokens and neurons", async () => {
    const calls = mockFetch(telegramOk);
    await handleUpdate({ ...env, AI: fakeAi() }, new Store(env.DB), { message: { chat: { id: 1001 }, text: "/aitest" } },
      new Date(), "https://worker.test");
    const [text] = sentTexts(calls);
    expect(text).toContain("3000");
    expect(text).toContain("500");
    expect(text).toContain("182 neurons");
  });
});
