/** The analysis queue: when an analysis may start, the Workflow that runs it, and the review schedule. */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { AiRateLimited, neuronsToday } from "./ai";
import type { Env } from "./env";
import { runAnalysis, type Step } from "./pipeline";
import { Store } from "./store";
import { send } from "./telegram";
import { localParts } from "./time";

export const NEURON_GUARD = 9000; // of the free 10,000 a day: leave room so a started analysis can finish
const PAUSE_MS = 30 * 60_000;
const REFUND_MS = 60_000; // refused within a minute: before most of the run's calls, so it doesn't use a daily slot
const STUCK_MS = 20 * 60_000;
const PAUSE_KEY = "ai_paused_until";

export type Wait = "paused" | "limit" | "neurons";

/** Whether a new analysis may start now, and if not why (and until when, for a pause). */
export async function analysisGate(env: Env, store: Store, now: Date): Promise<{ wait: Wait | null; until?: string; runsLeft: number }> {
  const max = Number(env.MAX_RUNS_PER_DAY ?? 3) || 3;
  const used = await store.countRunsOn(localParts(now, env.OWNER_TZ).date, env.OWNER_TZ);
  const runsLeft = Math.max(0, max - used);
  const paused = await store.getSetting(PAUSE_KEY);
  if (paused && now < new Date(paused)) return { wait: "paused", until: paused, runsLeft };
  if (!runsLeft) return { wait: "limit", runsLeft };
  if ((await neuronsToday(store, env, now)) >= NEURON_GUARD) return { wait: "neurons", runsLeft };
  return { wait: null, runsLeft };
}

/** Called every minute: start the next queued analysis if nothing runs and the gate allows it. */
export async function drainQueue(env: Env, store: Store, now: Date): Promise<void> {
  const running = (await store.runningItems())[0];
  if (running) {
    const started = await store.getSetting(`analysis_started:${running.id}`);
    if (started && now.getTime() - new Date(started).getTime() > STUCK_MS) {
      await store.setQueueStatus(running.id, "failed");
      await send(env, `The analysis of ${running.code} took too long and was stopped. Ask me to run it again.`);
    }
    return;
  }
  if ((await analysisGate(env, store, now)).wait) return;
  const item = await store.nextQueued();
  if (!item) return;
  await store.setQueueStatus(item.id, "running");
  await store.recordRun(item.code, now);
  await store.setSetting(`analysis_started:${item.id}`, now.toISOString());
  await env.ANALYSIS.create({ params: { itemId: item.id, startedAt: now.toISOString() } });
}

/** Runs one queue item and settles its state whatever happens. */
export async function executeItem(env: Env, store: Store, itemId: number, startedAt: string, clock: () => Date,
  run: () => Promise<void>): Promise<void> {
  const item = await store.queueItem(itemId);
  if (!item || item.status !== "running") return;
  try {
    await run();
  } catch (e) {
    const now = clock(); // when it failed, not when it started
    if (e instanceof AiRateLimited) {
      await store.setQueueStatus(itemId, "pending"); // try again after the pause
      await store.setSetting(PAUSE_KEY, new Date(now.getTime() + PAUSE_MS).toISOString());
      if (now.getTime() - new Date(startedAt).getTime() < REFUND_MS) await store.forgetRun(item.code, new Date(startedAt));
      return;
    }
    console.error("analysis failed", e instanceof Error ? e.name : typeof e); // the message may carry secrets
    await store.setQueueStatus(itemId, "failed");
    await send(env, `The analysis of ${item.code} failed (${e instanceof Error ? e.name : "error"}). Ask me to try again.`);
  }
}

/** Monday 20:00 owner time: review every holding. */
export async function scheduleReviews(env: Env, store: Store, now: Date): Promise<void> {
  const local = localParts(now, env.OWNER_TZ);
  if (local.weekday !== 1 || local.hour < 20) return;
  if (!(await store.markOnce(`weekly:${local.date}`, now))) return;
  for (const p of await store.lastPositions()) await store.enqueue(p.code, "weekly", 2, now);
}

type Params = { itemId: number; startedAt: string };

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    const store = new Store(this.env.DB);
    // Two retries 30 s apart ride out a brief "capacity exceeded"; more would just spend neurons.
    const steps: Step = {
      do: (name, fn) => step.do(name, { retries: { limit: 2, delay: "30 seconds", backoff: "constant" } }, fn as never) as never,
    };
    const item = await store.queueItem(event.payload.itemId);
    if (!item) return;
    await executeItem(this.env, store, item.id, event.payload.startedAt, () => new Date(),
      () => runAnalysis(steps, this.env, store, item, new Date(event.payload.startedAt)));
  }
}
