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
