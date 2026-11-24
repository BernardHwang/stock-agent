import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    // Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them; vitest.config.ts supplies test values.
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      TELEGRAM_BOT_TOKEN: string;
      TELEGRAM_WEBHOOK_SECRET: string;
      OWNER_CHAT_ID: string;
      MOOMOO_CLIENT_ID: string;
    }
  }
}
