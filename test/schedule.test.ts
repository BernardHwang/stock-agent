import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { type Jobs, runSchedule } from "../src/schedule";
import { Store } from "../src/store";

const DAYS = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30"];

function jobs(overrides: Partial<Jobs> = {}): Jobs {
  return {
    outcomes: vi.fn(async () => {}), consensus: vi.fn(async () => {}), brief: vi.fn(async () => {}), preOpen: vi.fn(async () => {}),
    review: vi.fn(async () => {}), weekly: vi.fn(async () => {}), events: vi.fn(async () => {}), ...overrides,
  };
}

async function store() {
  const s = new Store(env.DB);
  await s.setSetting("trading_days", JSON.stringify(DAYS));
  return s;
}

// MYT is UTC+8: Wed 2026-11-25 08:00 MYT = 2026-11-25T00:00Z (Tue 19:00 EST, inside the 24h price window).
const myt = (date: string, hhmm: string) => new Date(new Date(`${date}T${hhmm}:00+08:00`).toISOString());

describe("runSchedule", () => {
  it("runs the morning brief once, on the first minute at or after 08:00", async () => {
    const s = await store();
    const j = jobs();
    await runSchedule(env, s, myt("2026-11-25", "07:59"), j);
    expect(j.brief).not.toHaveBeenCalled();
    await runSchedule(env, s, myt("2026-11-25", "08:00"), j);
    await runSchedule(env, s, myt("2026-11-25", "08:01"), j);
    expect(j.brief).toHaveBeenCalledTimes(1);
  });

  it("catches up a missed minute, but not hours later", async () => {
    const s = await store();
    const j = jobs();
    await runSchedule(env, s, myt("2026-11-25", "08:03"), j);
    expect(j.brief).toHaveBeenCalledTimes(1);
    await runSchedule(env, s, myt("2026-11-26", "15:00"), j); // e.g. a deploy in the afternoon
    expect(j.brief).toHaveBeenCalledTimes(1);
  });

  it("runs each daily job at its time", async () => {
    const s = await store();
    const j = jobs();
    for (const t of ["07:40", "07:50", "21:00"]) await runSchedule(env, s, myt("2026-11-25", t), j);
    expect(j.outcomes).toHaveBeenCalledTimes(1);
    expect(j.consensus).toHaveBeenCalledTimes(1);
    expect(j.preOpen).toHaveBeenCalledTimes(1);
    expect(j.review).not.toHaveBeenCalled();
  });

  it("runs the review on Sunday 10:00", async () => {
    const s = await store();
    const j = jobs();
    await runSchedule(env, s, myt("2026-11-28", "10:00"), j); // Saturday
    await runSchedule(env, s, myt("2026-11-29", "10:00"), j);
    expect(j.review).toHaveBeenCalledTimes(1);
  });

  it("checks events at :00 and :30 New York time inside the price window", async () => {
    const s = await store();
    const j = jobs();
    await runSchedule(env, s, new Date("2026-11-24T15:30:00Z"), j); // Tue 10:30 EST
    await runSchedule(env, s, new Date("2026-11-24T15:31:00Z"), j);
    await runSchedule(env, s, new Date("2026-11-28T15:30:00Z"), j); // Saturday
    expect(j.events).toHaveBeenCalledTimes(1);
  });

  it("keeps going when one job fails", async () => {
    const s = await store();
    const j = jobs({ brief: vi.fn(async () => { throw new Error("boom"); }) });
    await runSchedule(env, s, myt("2026-11-25", "08:00"), j); // also :00 New York time inside the window
    expect(j.events).toHaveBeenCalledTimes(1);
    expect(j.weekly).toHaveBeenCalledTimes(1);
  });
});
