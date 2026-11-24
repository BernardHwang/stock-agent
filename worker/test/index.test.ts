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
