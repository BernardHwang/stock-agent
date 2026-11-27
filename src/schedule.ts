/**
 * What runs when, in one place. Daily jobs run on the first cron minute at or after their owner-local time, once per
 * local date, and only within CATCH_UP_MIN of it (a deploy in the afternoon doesn't send the morning brief).
 */
import { morningBrief, preOpenNote, storedTradingDays } from "./briefs";
import type { Env } from "./env";
import { checkConsensus, checkEvents } from "./events";
import { learn } from "./lessons";
import { updateOutcomes } from "./outcomes";
import { sundayReview } from "./review";
import type { Store } from "./store";
import { send } from "./telegram";
import { inPriceWindow, localParts } from "./time";
import { scheduleReviews } from "./workflow";

type Job = (env: Env, store: Store, now: Date) => Promise<void>;
export interface Jobs {
  outcomes: Job;
  consensus: Job;
  brief: Job;
  preOpen: Job;
  review: Job;
  weekly: Job;
  events: Job;
}

const CATCH_UP_MIN = 60;

/** Owner-local times; weekday 0 is Sunday. */
const DAILY: { job: Exclude<keyof Jobs, "weekly" | "events">; hour: number; minute: number; weekday?: number }[] = [
  { job: "outcomes", hour: 7, minute: 40 },
  { job: "consensus", hour: 7, minute: 50 },
  { job: "brief", hour: 8, minute: 0 },
  { job: "review", hour: 10, minute: 0, weekday: 0 },
  { job: "preOpen", hour: 21, minute: 0 },
];

async function sendLogged(env: Env, store: Store, text: string | null, now: Date): Promise<void> {
  if (!text) return;
  await send(env, text);
  await store.logChat("alert", text, now); // so the chat knows what it told you
}

export const DEFAULT_JOBS: Jobs = {
  outcomes: async (env, store, now) => {
    for (const outcome of await updateOutcomes(env, store, now)) {
      const plan = await store.getPlan(outcome.planId);
      if (plan) await learn(env, store, outcome, plan, now);
    }
  },
  consensus: async (env, store, now) => void (await checkConsensus(env, store, now)),
  brief: async (env, store, now) => sendLogged(env, store, await morningBrief(env, store, now), now),
  preOpen: async (env, store, now) => sendLogged(env, store, await preOpenNote(env, store, now), now),
  review: async (env, store, now) => sendLogged(env, store, await sundayReview(env, store, now), now),
  weekly: scheduleReviews, // Monday 20:00: every holding queued for a fresh analysis (gated inside)
  events: async (env, store, now) => void (await checkEvents(env, store, now)),
};

async function guarded(name: string, job: () => Promise<void>): Promise<void> {
  try {
    await job();
  } catch (e) {
    console.error(`${name} failed`, e instanceof Error ? e.name : typeof e); // the message may carry secrets
  }
}

export async function runSchedule(env: Env, store: Store, now: Date, jobs: Jobs = DEFAULT_JOBS): Promise<void> {
  const local = localParts(now, env.OWNER_TZ);
  const minutes = local.hour * 60 + local.minute;
  for (const d of DAILY) {
    const at = d.hour * 60 + d.minute;
    if (d.weekday !== undefined && d.weekday !== local.weekday) continue;
    if (minutes < at || minutes >= at + CATCH_UP_MIN) continue;
    if (!(await store.markOnce(`job:${d.job}:${local.date}`, now))) continue;
    await guarded(d.job, () => jobs[d.job](env, store, now));
  }
  await guarded("weekly", () => jobs.weekly(env, store, now));
  const ny = localParts(now, "America/New_York");
  if (ny.minute % 30 === 0) {
    const days = await storedTradingDays(store);
    if (inPriceWindow(now, days, env.PRICE_HOURS)) await guarded("events", () => jobs.events(env, store, now));
  }
}
