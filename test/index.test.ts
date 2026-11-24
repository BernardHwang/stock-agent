import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("router", () => {
  it("answers the health check", async () => {
    const res = await exports.default.fetch("https://worker.test/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await exports.default.fetch("https://worker.test/nope");
    expect(res.status).toBe(404);
  });
});

describe("scheduled", () => {
  it("runs the minute job and never throws", async () => {
    const { env } = await import("cloudflare:test");
    const { vi } = await import("vitest");
    const { Store } = await import("../src/store");
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r"); // connected, but moomoo is unreachable
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    const { createExecutionContext, createScheduledController } = await import("cloudflare:test");
    const worker = (await import("../src/index")).default;
    await worker.scheduled(createScheduledController(), env, createExecutionContext());
    expect(await store.getSetting("moomoo_failures")).toBe("1");
    vi.restoreAllMocks();
  });
});

describe("telegram errors", () => {
  it("tells the owner when handling a message fails, instead of staying silent", async () => {
    const { env } = await import("cloudflare:test");
    const { vi } = await import("vitest");
    const { mockFetch, sentTexts, telegramOk } = await import("./helpers");
    const calls = mockFetch(telegramOk);
    await env.DB.exec("ALTER TABLE chat_log RENAME TO chat_log_hidden"); // as if the migration never ran
    try {
      const res = await exports.default.fetch("https://worker.test/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
        body: JSON.stringify({ update_id: 1, message: { chat: { id: 1001 }, text: "analyze MDB" } }),
      });
      expect(res.status).toBe(200);
      const [text] = sentTexts(calls);
      expect(text).toContain("Something went wrong");
      expect(text).not.toContain("chat_log"); // no internal details
    } finally {
      await env.DB.exec("ALTER TABLE chat_log_hidden RENAME TO chat_log");
      vi.restoreAllMocks();
    }
  });
});
