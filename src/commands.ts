import { aiProbe, DEFAULT_MODEL, estimateNeurons } from "./aiprobe";
import type { Env } from "./env";
import { syncFromMoomoo } from "./holdings";
import { apiGet, quotePost } from "./moomoo/api";
import { accessToken, clientId, connectUrl, disconnect } from "./moomoo/oauth";
import type { Store } from "./store";
import { send, type Update } from "./telegram";
import { inPriceWindow, inUsSession } from "./time";

/** Telegram's "/" menu, in order. Menu entries can't take arguments, so every feature is its own command. */
export const COMMANDS: [name: string, description: string][] = [
  ["help", "All commands and what runs automatically"],
  ["status", "moomoo link, last sync, plans and market state"],
  ["holdings", "Your positions from the last sync"],
  ["sync", "Sync positions from moomoo now"],
  ["moomoo", "Connect moomoo (read-only) or show the link"],
  ["reconnect", "Sign in to moomoo again before it expires"],
  ["disconnect", "Disconnect moomoo and delete its access"],
  ["probe", "Show a raw moomoo answer (setup aid)"],
  ["aitest", "Measure one AI call's neuron cost"],
];

const HELP = [
  "Portfolio",
  "/holdings - your positions from the last sync",
  "/sync - sync positions from moomoo now",
  "/status - moomoo link, last sync, active plans, US market state",
  "",
  "moomoo (read-only: positions and quotes, never trading)",
  "/moomoo - connect, or show the link and when its sign-in expires",
  "/reconnect - sign in again before the sign-in runs out (every ~14 days)",
  "/disconnect - disconnect and delete the stored access",
  "",
  "Setup aids",
  "/probe [post] <path> [json] - raw answer from a /api/v1.0/quote/ or /api/v1.0/accounts/ path, ids masked",
  "/aitest [model] - tokens and neurons of one AI call (free: 10,000 neurons a day)",
  "",
  "Automatic",
  "Stop-loss warning - every minute on US trading days (24h incl. pre-market, after-hours and overnight), once per plan",
  "Holdings sync - every 15 min in US market hours, and 07:55 Malaysia time",
  "moomoo problems - one note after 3 failed minutes, one when it recovers",
  "",
  "/help - this guide (the \"/\" menu lists every command)",
  "",
  "Coming next: analysis (plans with buy zone, target and stop), chat, daily briefs.",
].join("\n");

const UNKNOWN = "Unknown command. Send /help.";
const NOT_A_COMMAND = "I only understand commands for now; chat is coming. Send /help to see them.";

async function aiTest(env: Env, model: string): Promise<void> {
  try {
    const r = await aiProbe(env.AI, model);
    const neurons = estimateNeurons(model, r.promptTokens, r.completionTokens);
    return send(env, `${model}\nTokens: ${r.promptTokens} in, ${r.completionTokens} out, ${r.ms} ms\n` +
      (neurons === null ? "No neuron rate known for this model." :
        `About ${Math.round(neurons)} neurons (free allowance: 10,000 a day).`));
  } catch (e) {
    return send(env, `AI test failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleUpdate(env: Env, store: Store, update: unknown, now: Date, origin: string): Promise<void> {
  const msg = (update as Update).message;
  if (!msg || String(msg.chat.id) !== env.OWNER_CHAT_ID || !msg.text) return;
  if (!msg.text.startsWith("/")) return send(env, NOT_A_COMMAND);
  const [head = "", ...args] = msg.text.trim().split(/\s+/);
  const name = head.slice(1).split("@")[0]!.toLowerCase();
  switch (name) {
    case "start":
    case "help":
      return send(env, HELP);
    case "status":
      return send(env, await statusText(env, store, now));
    case "holdings":
      return send(env, await holdingsText(store));
    case "moomoo":
      return moomooCommand(env, store, args, now, origin);
    case "sync":
    case "reconnect":
    case "probe":
      return moomooCommand(env, store, [name, ...args], now, origin);
    case "disconnect":
      return moomooCommand(env, store, ["off"], now, origin);
    case "aitest":
      return aiTest(env, args[0] ?? DEFAULT_MODEL);
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

async function syncCommand(env: Env, store: Store, now: Date): Promise<void> {
  try {
    const result = await syncFromMoomoo(env, store, now);
    if (!result) return send(env, "moomoo isn't connected. Send /moomoo to connect.");
    const summary = `Synced ${result.count} position${result.count === 1 ? "" : "s"} from moomoo.`;
    return send(env, [...result.messages, summary].join("\n\n"));
  } catch {
    return send(env, "moomoo didn't respond, so nothing was synced. Try /sync again in a moment.");
  }
}

const PROBE_PREFIXES = ["/api/v1.0/quote/", "/api/v1.0/accounts/"];

/** Setup aid: show the raw shape of a read-only moomoo endpoint. `/probe [post] <path> [json]`. */
async function probe(env: Env, store: Store, args: string[], now: Date): Promise<void> {
  const post = args[0]?.toLowerCase() === "post";
  const path = (post ? args[1] : args[0]) ?? "";
  if (!PROBE_PREFIXES.some((p) => path.startsWith(p))) {
    return send(env, "Usage: /probe [post] <path> [json]. Probe reads only /api/v1.0/quote/ and /api/v1.0/accounts/ paths.");
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
  if (!(await clientId(env, store))) {
    return send(env, "moomoo isn't set up yet: set PUBLIC_URL so the bot registers itself (or MOOMOO_CLIENT_ID).");
  }
  const sub = args[0]?.toLowerCase() ?? "";
  if (sub === "probe") return probe(env, store, args.slice(1), now);
  if (sub === "sync") return syncCommand(env, store, now);
  if (sub === "off") {
    await disconnect(store);
    return send(env, "moomoo disconnected and the stored access deleted. To fully revoke it, remove the app in " +
      "moomoo's settings too.");
  }
  const connected = Boolean(await store.getSetting("moomoo_refresh"));
  if (connected && sub !== "reconnect") {
    const until = await store.getSetting("moomoo_until");
    return send(env, `moomoo is connected, read-only.${until ? ` The sign-in lasts until ${until}.` : ""}\n\n` +
      "/reconnect to sign in again before it expires\n/disconnect to disconnect");
  }
  const url = await connectUrl(env, store, origin, now);
  return send(env, (connected ? "Sign in again to keep moomoo connected. The current link stays until the new one " +
      "is confirmed.\n\n" : "") +
    "Connect moomoo, read-only:\n1. Tap the button and sign in on moomoo's page.\n2. Allow reading positions and " +
    "quotes, and leave trading OFF.\n3. You'll be sent back and I'll confirm here.\n\nIf a trading permission comes " +
    "through anyway, I throw the access away. The link is good for 15 minutes.", [[{ text: "Connect moomoo", url }]]);
}
