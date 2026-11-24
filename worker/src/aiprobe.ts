/** One measured Workers AI call, to size the analysis pipeline against the free 10,000 neurons a day. */

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Neurons per million tokens, from https://developers.cloudflare.com/workers-ai/platform/pricing/ (2026-11-18). */
export const NEURONS_PER_M: Record<string, { in: number; out: number }> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 26668, out: 204805 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { in: 24545, out: 77273 },
  "@cf/meta/llama-3.1-8b-instruct-fp8": { in: 13778, out: 26128 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { in: 4625, out: 30475 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct": { in: 31876, out: 50488 },
};

export function estimateNeurons(model: string, promptTokens: number, completionTokens: number): number | null {
  const rate = NEURONS_PER_M[model];
  return rate ? (promptTokens * rate.in + completionTokens * rate.out) / 1_000_000 : null;
}

/** A synthetic research-report-sized prompt (about 3,000 tokens), like one analysis step's input. */
function samplePrompt(): string {
  const rows = Array.from({ length: 120 }, (_, i) =>
    `Day ${i + 1}: open ${(300 + i * 0.7).toFixed(2)}, high ${(304 + i * 0.7).toFixed(2)}, low ${(297 + i * 0.7).toFixed(2)}, ` +
    `close ${(301 + i * 0.7).toFixed(2)}, volume ${1_200_000 + i * 3_100}`);
  return "You are a market analyst. Summarise the trend, support and resistance in the data below in under 300 words.\n\n" +
    rows.join("\n");
}

export async function aiProbe(ai: Ai, model: string): Promise<{ promptTokens: number; completionTokens: number; ms: number }> {
  const started = Date.now();
  const out = (await ai.run(model as keyof AiModels, {
    messages: [{ role: "user", content: samplePrompt() }],
    max_tokens: 600,
  } as never)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return {
    promptTokens: out.usage?.prompt_tokens ?? 0,
    completionTokens: out.usage?.completion_tokens ?? 0,
    ms: Date.now() - started,
  };
}
