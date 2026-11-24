# stock-agent Worker (free Cloudflare plan)

The serverless version of the stock agent, replacing the Python app's VM and OpenD.
It reads your moomoo account **read-only** over moomoo's web API, keeps holdings in D1, and sends a Telegram
**stop-loss warning** when a held position trades at or below its stop. That covers 24 hours on US trading days
(overnight, pre-market, regular, after-hours), or regular hours only with `PRICE_HOURS="regular"`.

Built so far: the platform, the moomoo link, holdings sync and the stop-loss warning.
Still to come: analysis, chat and briefs. Until then, plans only come from tests or the D1 console.

**It never trades.** A grant that includes `trade:write` is thrown away. The code only sends GETs to moomoo,
plus POSTs to the market-data (`/api/v1.0/quote/`) endpoints. `test/safety.test.ts` fails if that changes.

## Telegram commands

| Command | What it does |
|---|---|
| `/help` | List commands |
| `/status` | moomoo link, last sync, active plans, market state |
| `/holdings` | Positions from the last sync |
| `/moomoo` | Connect moomoo read-only, or show the link state |
| `/moomoo sync` | Sync positions now |
| `/moomoo reconnect` | Sign in again before the sign-in expires (default 14 days) |
| `/moomoo off` | Disconnect and delete the stored access |
| `/moomoo probe [post] <path> [json]` | Setup aid: show a raw `/api/v1.0/quote/` or `/api/v1.0/accounts/` answer, with ids masked |
| `/aitest [model]` | Measure one Workers AI call: tokens and estimated neurons (free: 10,000/day) |

## What runs when

The cron fires every minute.

- **Trading calendar:** fetched from moomoo once per New York day.
- **Holdings sync:** every 15 minutes in the US regular session, plus 07:55 Malaysia time.
- **Stop-loss check:** every minute inside the price window. The price comes from the field of the session the
  New York clock is in.
- **Failures:** after 3 failed minutes you get one "moomoo is unreachable" note, and one "reachable again" note
  when it recovers.

## Develop

```
cd worker
npm install
npm test             # vitest in the Workers runtime, offline
npm run typecheck    # wrangler types --check + tsc
```

Run `npx wrangler types` after changing `wrangler.jsonc`.

## First deploy and live check

You run these steps; nothing is pushed or deployed automatically.

1. `cd worker && npx wrangler login`
2. `npx wrangler d1 create stock-agent`, then put the printed `database_id` into `wrangler.jsonc`.
3. `npx wrangler d1 migrations apply stock-agent --remote`
4. Set the secrets with `npx wrangler secret put <NAME>`:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` (any long random string)
   - `OWNER_CHAT_ID` (your private chat id)
5. `npx wrangler deploy`. Note the `https://stock-agent.<you>.workers.dev` URL.
6. Register a moomoo client. Self-service, no approval:
   ```
   curl -s -X POST https://webapi.moomoo.com/oauth2/register -H "content-type: application/json" \
     -d '{"client_name":"stock-agent","redirect_uris":["https://stock-agent.<you>.workers.dev/moomoo/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}'
   ```
   Store the returned `client_id` with `npx wrangler secret put MOOMOO_CLIENT_ID`. Don't paste the response anywhere.
7. Point Telegram at the Worker. If the old Python bot still polls with this token, stop it first:
   ```
   curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://stock-agent.<you>.workers.dev/telegram" -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
8. In Telegram, check each of these:
   - `/help` answers.
   - `/moomoo` connects. On moomoo's page allow **positions and quotes only**, and leave trading **off**.
   - `/moomoo sync` lists your positions.
   - `/moomoo probe post /api/v1.0/quote/snapshot {"code_list":["US.MDB"]}`: run it at about 13:00, 18:00 and 06:00
     Malaysia time, and note whether `overnight_price`, `pre_price` and `after_price` are filled. If they stay 0,
     set `PRICE_HOURS` to `"regular"` in `wrangler.jsonc` and redeploy.
   - `/moomoo probe /api/v1.0/quote/trading-days?market=US&begin=<today>&end=<+30d>` shows trading dates. If
     moomoo wants other parameter names, adjust `tradingDays()` in `src/moomoo/api.ts`.
   - `/aitest` reports the neuron cost of one 70B call. This sizes the coming analysis pipeline.
9. Replace the fixtures in `test/fixtures/` with the real, masked answers from step 8, then run `npm test`.

## Limits on the free plan

- 10 ms CPU per invocation (waiting on fetch doesn't count).
- 50 outside requests per invocation; a minute uses at most a handful.
- 100,000 requests a day; the cron uses 1,440.
- moomoo allows 100 requests a minute per IP, and Cloudflare's outgoing IPs are shared.
