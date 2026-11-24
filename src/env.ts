export interface Env {
  DB: D1Database;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_CHAT_ID: string;
  MOOMOO_CLIENT_ID?: string;
  OWNER_TZ: string;
  PRICE_HOURS: "24h" | "regular";
}
