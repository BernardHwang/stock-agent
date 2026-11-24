import { describe, expect, it } from "vitest";
import { inPriceWindow, inUsSession, localParts } from "../src/time";

describe("localParts", () => {
  it("gives the owner's local date and time", () => {
    expect(localParts(new Date("2026-11-24T16:05:00Z"), "Asia/Kuala_Lumpur")).toEqual({
      date: "2026-11-25", hour: 0, minute: 5, weekday: 3,
    });
  });
});

describe("inUsSession", () => {
  const days = new Set(["2026-11-24", "2026-07-15"]);
  it("opens at 09:30 New York time in winter", () => {
    expect(inUsSession(new Date("2026-11-24T14:30:00Z"), days)).toBe(true);
    expect(inUsSession(new Date("2026-11-24T14:29:00Z"), days)).toBe(false);
  });
  it("is closed at 16:00", () => {
    expect(inUsSession(new Date("2026-11-24T21:00:00Z"), days)).toBe(false);
  });
  it("follows daylight saving time", () => {
    expect(inUsSession(new Date("2026-07-15T13:30:00Z"), days)).toBe(true);
  });
  it("is closed on a day that is not a trading day", () => {
    expect(inUsSession(new Date("2026-11-26T15:00:00Z"), days)).toBe(false);
  });
});

describe("inPriceWindow", () => {
  const days = new Set(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"]);
  it("covers the overnight session in 24h mode only", () => {
    expect(inPriceWindow(new Date("2026-11-24T06:00:00Z"), days, "24h")).toBe(true);
    expect(inPriceWindow(new Date("2026-11-24T06:00:00Z"), days, "regular")).toBe(false);
  });
  it("is closed on a holiday", () => {
    expect(inPriceWindow(new Date("2026-11-26T15:00:00Z"), days, "24h")).toBe(false);
  });
  it("is closed on Sunday morning", () => {
    expect(inPriceWindow(new Date("2026-11-29T12:00:00Z"), days, "24h")).toBe(false);
  });
  it("opens at 20:00 New York time on the calendar day before a trading day", () => {
    expect(inPriceWindow(new Date("2026-11-23T00:59:00Z"), days, "24h")).toBe(false); // Sun 19:59
    expect(inPriceWindow(new Date("2026-11-23T01:00:00Z"), days, "24h")).toBe(true); // Sun 20:00, for Mon
  });
  it("runs through regular hours in 24h mode", () => {
    expect(inPriceWindow(new Date("2026-11-24T17:00:00Z"), days, "24h")).toBe(true);
  });
});
