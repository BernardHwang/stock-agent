import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// D1 storage is shared across tests in a file; start each test empty.
beforeEach(async () => {
  await env.DB.batch(["settings", "once_keys", "positions", "plans"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
