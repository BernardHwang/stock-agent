import { vi } from "vitest";

export interface Call {
  url: string;
  method: string;
  body: string;
}

/** Replace global fetch: ``route`` answers each request (undefined -> 404). Returns the recorded calls. */
export function mockFetch(route: (url: string, init: RequestInit) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : "" });
    return route(url, init) ?? new Response("not mocked", { status: 404 });
  });
  return calls;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Telegram texts sent by the bot, in order. */
export const sentTexts = (calls: Call[]) =>
  calls.filter((c) => c.url.includes("/sendMessage")).map((c) => JSON.parse(c.body).text as string);

export const telegramOk = (url: string) => (url.startsWith("https://api.telegram.org/") ? json({ ok: true }) : undefined);
