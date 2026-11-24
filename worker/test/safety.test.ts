import { describe, expect, it } from "vitest";

// Read-only brokerage: the source must not contain any way to trade.
const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const files = Object.entries(sources);

describe("read-only safety", () => {
  it("has source files to check", () => expect(files.length).toBeGreaterThan(5));

  it("never mentions orders or unlocking trading", () => {
    for (const [path, text] of files) {
      expect(text, path).not.toMatch(/\b(place|modify|cancel)_?orders?\b|\/orders?\b|unlock/i);
    }
  });

  it("mentions trade:write only where grants are refused", () => {
    for (const [path, text] of files) if (!path.endsWith("moomoo/oauth.ts")) expect(text, path).not.toContain("trade:write");
  });

  it("sends POST only to Telegram, the OAuth token endpoint and the quote API", () => {
    const allowed = ["telegram.ts", "moomoo/oauth.ts", "moomoo/api.ts"];
    for (const [path, text] of files) {
      if (!allowed.some((a) => path.endsWith(a))) expect(text, path).not.toMatch(/method: "POST"/);
    }
    const api = files.find(([p]) => p.endsWith("moomoo/api.ts"))![1];
    expect(api.match(/method: "POST"/g)).toHaveLength(1); // only inside quotePost
  });
});
