export interface Env {
  DB: D1Database;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  /** Optional: generated and kept in D1 when not set. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  OWNER_CHAT_ID: string;
  /** Optional: the Worker registers its own moomoo client when not set. */
  MOOMOO_CLIENT_ID?: string;
  /** The Worker's public address (e.g. https://stock-agent.you.workers.dev); enables self-setup. */
  PUBLIC_URL?: string;
  /** Workers AI models: QUICK for analysts and debaters, DEEP for manager, trader, portfolio manager and chat. */
  QUICK_MODEL?: string;
  DEEP_MODEL?: string;
  /** Analyses per owner-local day (default 3) and chat turns per day (default 30). */
  MAX_RUNS_PER_DAY?: string;
  CHAT_MAX_PER_DAY?: string;
  OWNER_TZ: string;
  PRICE_HOURS: "24h" | "regular";
}
