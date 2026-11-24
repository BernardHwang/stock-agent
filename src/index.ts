import { handleUpdate } from "./commands";
import { runMinute } from "./cron";
import type { Env } from "./env";
import { CALLBACK_PATH, handleCallback } from "./moomoo/oauth";
import { ensureSetup } from "./setup";
import { Store } from "./store";
import { hasValidSecret, webhookSecret } from "./telegram";
import { drainQueue, scheduleReviews } from "./workflow";

export { AnalysisWorkflow } from "./workflow";

/** Each minute job runs on its own, so one failing never stops the others. Errors log by name only (may hold secrets). */
async function guarded(name: string, job: () => Promise<void>): Promise<void> {
  try {
    await job();
  } catch (e) {
    console.error(`${name} failed`, e instanceof Error ? e.name : typeof e);
  }
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return new Response("ok");
    if (req.method === "GET" && url.pathname === CALLBACK_PATH) return handleCallback(req, env, new Store(env.DB), new Date());
    if (req.method === "POST" && url.pathname === "/telegram") {
      const store = new Store(env.DB);
      if (!hasValidSecret(req, await webhookSecret(env, store))) return new Response("unauthorized", { status: 401 });
      await guarded("telegram update", async () => handleUpdate(env, store, await req.json(), new Date(), url.origin));
      return new Response("ok"); // always 200 so Telegram doesn't retry a failing update forever
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = new Store(env.DB);
    const now = new Date(controller.scheduledTime);
    await guarded("setup", () => ensureSetup(env, store, now));
    await guarded("minute job", () => runMinute(env, store, now));
    await guarded("review schedule", () => scheduleReviews(env, store, now));
    await guarded("analysis queue", () => drainQueue(env, store, now));
  },
} satisfies ExportedHandler<Env>;
