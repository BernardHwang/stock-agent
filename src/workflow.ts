/** The analysis queue: when an analysis may start, the Workflow that runs it, and the review schedule. */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { isRateLimited, neuronsToday } from "./ai";
import type { Env } from "./env";
import { runAnalysis, type Step } from "./pipeline";
import { Store } from "./store";
import { send } from "./telegram";
import { localParts } from "./time";

export const NEURON_GUARD = 9000; // chat stops here, of the free 10,000 a day
const ANALYSIS_NEURON_GUARD = 8000; // an analysis costs up to ~2,000: start one only if it can finish
const PAUSE_MS = 30 * 60_000;
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
  if ((await neuronsToday(store, env, now)) >= ANALYSIS_NEURON_GUARD) return { wait: "neurons", runsLeft };
  return { wait: null, runsLeft };
}

/** Called every minute: start the next queued analysis if nothing runs and the gate allows it. */
export async function drainQueue(env: Env, store: Store, now: Date): Promise<void> {
  const running = (await store.runningItems())[0];
  if (running) {
    const started = await store.getSetting(`analysis_started:${running.id}`);
    if (started && now.getTime() - new Date(started).getTime() > STUCK_MS) {
      const instance = await store.getSetting(`analysis_instance:${running.id}`);
      if (instance) {
        try {
          await (await env.ANALYSIS.get(instance)).terminate(); // stop it spending neurons in the background
        } catch (e) {
          console.error("terminate failed", e instanceof Error ? e.name : typeof e);
        }
      }
      if (!(await store.setQueueStatusIf(running.id, "running", "failed"))) return;
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
  const instanceId = `item-${item.id}-${now.getTime()}`;
  await store.setSetting(`analysis_instance:${item.id}`, instanceId);
  await env.ANALYSIS.create({ id: instanceId, params: { itemId: item.id, startedAt: now.toISOString() } });
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
    // A run that failed before any AI call was paid for gives its daily slot back.
    const refund = async () => {
      if (!(await store.getSetting(`analysis_paid:${itemId}`))) await store.forgetRun(item.code, new Date(startedAt));
    };
    if (isRateLimited(e)) {
      if (!(await store.setQueueStatusIf(itemId, "running", "pending"))) return; // stopped meanwhile: stay stopped
      await store.setSetting(PAUSE_KEY, new Date(now.getTime() + PAUSE_MS).toISOString());
      await refund();
      return;
    }
    console.error("analysis failed", e instanceof Error ? e.name : typeof e); // the message may carry secrets
    if (!(await store.setQueueStatusIf(itemId, "running", "failed"))) return;
    await refund();
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
