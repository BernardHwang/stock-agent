import { handleUpdate } from "./commands";
import { runMinute } from "./cron";
import type { Env } from "./env";
import { CALLBACK_PATH, handleCallback } from "./moomoo/oauth";
import { Store } from "./store";
import { ensureSetup } from "./setup";
import { hasValidSecret, webhookSecret } from "./telegram";

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return new Response("ok");
    if (req.method === "GET" && url.pathname === CALLBACK_PATH) return handleCallback(req, env, new Store(env.DB), new Date());
    if (req.method === "POST" && url.pathname === "/telegram") {
      const store = new Store(env.DB);
      if (!hasValidSecret(req, await webhookSecret(env, store))) return new Response("unauthorized", { status: 401 });
      try {
        await handleUpdate(env, store, await req.json(), new Date(), url.origin);
      } catch (e) {
        console.error("telegram update failed", e instanceof Error ? e.name : typeof e); // no message: may hold secrets
      }
      return new Response("ok"); // always 200 so Telegram doesn't retry a failing update forever
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = new Store(env.DB);
    const now = new Date(controller.scheduledTime);
    try {
      await ensureSetup(env, store, now);
    } catch (e) {
      console.error("setup failed", e instanceof Error ? e.name : typeof e); // no message: may hold secrets
    }
    try {
      await runMinute(env, store, now);
    } catch (e) {
      console.error("minute job failed", e instanceof Error ? e.name : typeof e); // no message: may hold secrets
    }
  },
} satisfies ExportedHandler<Env>;
