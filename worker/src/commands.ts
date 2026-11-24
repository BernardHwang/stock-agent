import type { Env } from "./env";
import { apiGet, quotePost } from "./moomoo/api";
import { accessToken, connectUrl, disconnect } from "./moomoo/oauth";
import type { Store } from "./store";
import { send, type Update } from "./telegram";
import { inPriceWindow, inUsSession } from "./time";

/** The single source for /help and Telegram's "/" menu. */
export const COMMANDS: [name: string, description: string][] = [
  ["help", "What I can do"],
  ["status", "moomoo link, last sync and market state"],
  ["holdings", "Your moomoo positions"],
  ["moomoo", "Connect moomoo read-only (also: sync, reconnect, off)"],
];

const UNKNOWN = "Unknown command. Send /help.";

export async function handleUpdate(env: Env, store: Store, update: unknown, now: Date, origin: string): Promise<void> {
  const msg = (update as Update).message;
  if (!msg || String(msg.chat.id) !== env.OWNER_CHAT_ID || !msg.text?.startsWith("/")) return;
  const [head = "", ...args] = msg.text.trim().split(/\s+/);
  const name = head.slice(1).split("@")[0]!.toLowerCase();
  switch (name) {
    case "start":
    case "help":
      return send(env, ["Commands:", ...COMMANDS.map(([n, d]) => `/${n} - ${d}`)].join("\n"));
    case "status":
      return send(env, await statusText(env, store, now));
    case "holdings":
      return send(env, await holdingsText(store));
    case "moomoo":
      return moomooCommand(env, store, args, now, origin);
    default:
      return send(env, UNKNOWN);
  }
}

async function tradingDays(store: Store): Promise<Set<string> | null> {
  const raw = await store.getSetting("trading_days");
  return raw ? new Set(JSON.parse(raw) as string[]) : null;
}

async function statusText(env: Env, store: Store, now: Date): Promise<string> {
  const days = await tradingDays(store);
  const market = days === null ? "unknown (no trading calendar yet)"
    : inUsSession(now, days) ? "regular session open"
    : inPriceWindow(now, days, "24h") ? "extended hours" : "closed";
  return [
    `moomoo: ${(await store.getSetting("moomoo_refresh")) ? "connected (read-only)" : "not connected"}`,
    `Last holdings sync: ${(await store.getSetting("last_sync")) ?? "never"}`,
    `Active plans: ${(await store.activePlans()).length}`,
    `US market: ${market}`,
    `Price checks: ${env.PRICE_HOURS === "24h" ? "24h on trading days" : "regular hours"}`,
  ].join("\n");
}

async function holdingsText(store: Store): Promise<string> {
  const positions = await store.lastPositions();
  if (!positions.length) return "No holdings synced yet.";
  return ["Your holdings:", ...positions.map((p) => `${p.code}: ${p.qty} @ ${p.avgCost?.toFixed(2) ?? "?"}`)].join("\n");
}

const PROBE_PREFIXES = ["/api/v1.0/quote/", "/api/v1.0/accounts/"];

/** Setup aid: show the raw shape of a read-only moomoo endpoint. `/moomoo probe [post] <path> [json]`. */
async function probe(env: Env, store: Store, args: string[], now: Date): Promise<void> {
  const post = args[0]?.toLowerCase() === "post";
  const path = (post ? args[1] : args[0]) ?? "";
  if (!PROBE_PREFIXES.some((p) => path.startsWith(p))) {
    return send(env, "Probe reads only /api/v1.0/quote/ and /api/v1.0/accounts/ paths.");
  }
  const token = await accessToken(env, store, now);
  if (!token) return send(env, "moomoo isn't connected. Send /moomoo first.");
  try {
    const data = post ? await quotePost(token, path, JSON.parse(args.slice(2).join(" ") || "{}") as object)
      : await apiGet(token, path);
    // Mask account numbers (and any other long id) to their last 4 digits.
    const text = JSON.stringify(data).replace(/"?(\d{9,})"?/g, (_m, digits: string) => `"…${digits.slice(-4)}"`);
    return send(env, text.slice(0, 1500));
  } catch (e) {
    return send(env, `Probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function moomooCommand(env: Env, store: Store, args: string[], now: Date, origin: string): Promise<void> {
  if (!env.MOOMOO_CLIENT_ID) return send(env, "moomoo isn't configured on this bot (no MOOMOO_CLIENT_ID).");
  const sub = args[0]?.toLowerCase() ?? "";
  if (sub === "probe") return probe(env, store, args.slice(1), now);
  if (sub === "off") {
    await disconnect(store);
    return send(env, "moomoo disconnected and the stored access deleted. To fully revoke it, remove the app in " +
      "moomoo's settings too.");
  }
  const connected = Boolean(await store.getSetting("moomoo_refresh"));
  if (connected && sub !== "reconnect") {
    const until = await store.getSetting("moomoo_until");
    return send(env, `moomoo is connected, read-only.${until ? ` The sign-in lasts until ${until}.` : ""}\n\n` +
      "/moomoo reconnect to sign in again before it expires\n/moomoo off to disconnect");
  }
  const url = await connectUrl(env, store, origin, now);
  return send(env, (connected ? "Sign in again to keep moomoo connected. The current link stays until the new one " +
      "is confirmed.\n\n" : "") +
    "Connect moomoo, read-only:\n1. Tap the button and sign in on moomoo's page.\n2. Allow reading positions and " +
    "quotes, and leave trading OFF.\n3. You'll be sent back and I'll confirm here.\n\nIf a trading permission comes " +
    "through anyway, I throw the access away. The link is good for 15 minutes.", [[{ text: "Connect moomoo", url }]]);
}
