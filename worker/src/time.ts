const NY = "America/New_York";

export interface LocalParts {
  date: string;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(now: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export type Session = "overnight" | "pre" | "regular" | "after";

/** Which US trading session the New York clock is in (ignores holidays; pair with the trading calendar). */
export function marketSession(now: Date): Session {
  const ny = localParts(now, NY);
  const minutes = ny.hour * 60 + ny.minute;
  if (minutes < 4 * 60 || minutes >= 20 * 60) return "overnight";
  if (minutes < 9 * 60 + 30) return "pre";
  return minutes < 16 * 60 ? "regular" : "after";
}

/** US regular session: 09:30 to 16:00 New York time on a trading day. */
export function inUsSession(now: Date, tradingDays: ReadonlySet<string>): boolean {
  const ny = localParts(now, NY);
  const minutes = ny.hour * 60 + ny.minute;
  return tradingDays.has(ny.date) && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/**
 * When prices are checked. "24h" follows moomoo's 24/5 US trading: the window for a trading day runs from 20:00 New
 * York time the evening before to 20:00 that day (overnight, pre-market, regular, after-hours).
 */
export function inPriceWindow(now: Date, tradingDays: ReadonlySet<string>, hours: "24h" | "regular"): boolean {
  if (hours === "regular") return inUsSession(now, tradingDays);
  const ny = localParts(now, NY);
  return tradingDays.has(ny.hour >= 20 ? nextDate(ny.date) : ny.date);
}
