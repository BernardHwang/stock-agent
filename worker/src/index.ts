import { handleUpdate } from "./commands";
import type { Env } from "./env";
import { Store } from "./store";
import { hasValidSecret } from "./telegram";

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return new Response("ok");
    if (req.method === "POST" && url.pathname === "/telegram") {
      if (!hasValidSecret(req, env)) return new Response("unauthorized", { status: 401 });
      try {
        await handleUpdate(env, new Store(env.DB), await req.json(), new Date(), url.origin);
      } catch (e) {
        console.error("telegram update failed", e instanceof Error ? e.name : typeof e); // no message: may hold secrets
      }
      return new Response("ok"); // always 200 so Telegram doesn't retry a failing update forever
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {},
} satisfies ExportedHandler<Env>;
