# stock-agent

A personal, **alert-only** stock agent that runs as a free Cloudflare Worker.
It reads your moomoo account **read-only** over moomoo's web API, analyses stocks with a TradingAgents-style
team of AI roles, saves a plan (buy zone, take-profit, stop-loss) and sends a Telegram **stop-loss warning** when
a held position trades at or below its stop. That covers 24 hours on US trading days (overnight, pre-market,
regular, after-hours), or regular hours only with `PRICE_HOURS="regular"`. You talk to it in plain language.

Still to come: daily briefs, event notes, plan outcomes and lessons. The earlier Python version is in git history
at commit `9c81be3`; `config/universe.yaml` and `config/screener.yaml` are its screener inputs, kept for the
coming screener.

> Informational only, not financial advice.

**It never trades.** A grant that includes `trade:write` is thrown away. The code only sends GETs to moomoo,
plus POSTs to the market-data (`/api/v1.0/quote/`) endpoints. `test/safety.test.ts` fails if that changes.

## Chat

Write to the bot in plain language; it uses read-only tools on your holdings, plans, reports, quotes and news:

- "analyze MDB": queues a full analysis; the plan arrives as its own message a few minutes later.
- "what's my plan for NVDA?", "how are my holdings?", "any news on SPCX?", "show all my plans".
- Reply to one of the bot's messages (e.g. a stop-loss warning) to ask about it.

## Analysis

Each analysis is a Cloudflare Workflow, one at a time from a queue:

1. **Verified data sheet**, built in code: 370 daily candles from moomoo with SMA 20/50/200, RSI, MACD,
   Bollinger bands and ATR; valuation, key financial ratios, PE percentile, analyst consensus and short interest
   from moomoo; headlines from Yahoo (the analysis still runs if Yahoo is unreachable).
2. **11 roles, one AI call each**: market, news and fundamentals analysts; bull and bear; research manager;
   trader; aggressive, neutral and conservative risk; portfolio manager (writes the plan as JSON). Instructions
   live in `skills/*.md`, adapted from TradingAgents v0.7.1 (Apache-2.0; see `skills/NOTICE.md`).
3. **Checks**: the plan must pass the same rules as before (levels in order, stop below the price, buy zone
   within -25%/+10% of the price); one retry with the reasons, otherwise no plan is saved and you're told why.

Triggers: chat ("analyze X"), a newly found holding, and a review of every holding on Monday 20:00 Malaysia time.
Limits (vars in `wrangler.jsonc`): `MAX_RUNS_PER_DAY` (3) and `CHAT_MAX_PER_DAY` (30); both stop politely above
9,000 estimated neurons today, and analyses pause 30 minutes after Workers AI refuses for capacity.
Models: `QUICK_MODEL` (Llama 4 Scout) for analysts and debaters, `DEEP_MODEL` (Llama 3.3 70B) for the manager,
trader, portfolio manager and chat.

## Telegram commands

All of these are in Telegram's "/" menu; `/help` also lists what runs automatically.

| Command | What it does |
|---|---|
| `/help` | All commands and what runs automatically |
| `/status` | moomoo link, last sync, active plans, market state |
| `/holdings` | Positions from the last sync |
| `/sync` | Sync positions from moomoo now |
| `/moomoo` | Connect moomoo read-only, or show the link and when its sign-in expires |
| `/reconnect` | Sign in again before the sign-in expires (default 14 days) |
| `/disconnect` | Disconnect and delete the stored access |
| `/probe [post] <path> [json]` | Setup aid: show a raw `/api/v1.0/quote/` or `/api/v1.0/accounts/` answer, with ids masked |
| `/aitest [model]` | Measure one Workers AI call: tokens and estimated neurons (free: 10,000/day) |

The older forms `/moomoo sync`, `/moomoo reconnect`, `/moomoo off` and `/moomoo probe` still work.

## What runs when

The cron fires every minute.

- **Trading calendar:** fetched from moomoo once per New York day.
- **Holdings sync:** every 15 minutes in the US regular session, plus 07:55 Malaysia time.
- **Price alerts:** every minute inside the price window, once per level. Holdings: stop-loss, partial take-profit
  and take-profit. Buy plans: the buy zone is reached, or the stop breaks first (the plan is then cancelled). The
  price comes from the field of the session the New York clock is in.
- **Analysis queue:** one analysis at a time, at most `MAX_RUNS_PER_DAY` a day. New holdings, Monday 20:00 (every
  holding), event notes on a holding and the Sunday review's top idea all queue one.

Daily jobs run on the first cron minute at or after their Malaysia time (`OWNER_TZ`), once a day, within an hour
of it (`src/schedule.ts`):

| Time | What |
|---|---|
| 07:40 | Plan scoring: each plan's first level hit and its 4/12/26-week return; a decisive outcome writes a lesson that the next analysis of that stock reads |
| 07:50 | Analyst consensus check on holdings (a new rating or an average target moved 5%+ is an event) |
| 08:00 | Morning brief after each US trading day: indexes, holdings vs cost, stops and targets, earnings in 7 days, news, and one AI line |
| 10:00 Sunday | Weekly review: the week, the plan scorecard, up to 3 screener ideas (the top one is analysed) |
| 21:00 | Pre-open note on trading days, when holdings move pre-market or report earnings |
| every 30 min | Event notes inside the price window: major relevant news or a 5% move, at most 3 a day |

AI lines in briefs, notes, lessons and the review are skipped at 8,500 neurons a day, so analyses keep their budget.
- **Failures:** after 3 failed minutes you get one "moomoo isn't answering as expected" note, and one "reachable again" note
  when it recovers.

## Develop

```
npm install
npm test             # vitest in the Workers runtime, offline
npm run typecheck    # tsc
npm run types        # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

For `npx wrangler dev`, copy `.dev.vars.example` to
`.dev.vars`; keep a `.dev.vars` file even if empty, so wrangler never falls back to reading a stray `.env`.

| Path | What |
|---|---|
| `src/index.ts` | Routes (`/health`, `/telegram`, `/moomoo/callback`) and the per-minute cron |
| `src/setup.ts` | Self-setup after a deploy: Telegram webhook, command menu, moomoo client |
| `src/chat/` | Chat: tools (`tools.ts`) and the turn engine (`engine.ts`) |
| `src/workflow.ts`, `src/pipeline.ts` | Analysis queue and Workflow; the 11-role pipeline |
| `src/datasheet.ts`, `src/indicators.ts`, `src/moomoo/research.ts`, `src/news.ts` | The verified data sheet |
| `src/ai.ts`, `src/extract.ts`, `src/lifecycle.ts`, `src/messages.ts` | AI calls and neuron tally; plan parsing, saving and messages |
| `skills/` | Role instructions (adapted from TradingAgents) |
| `src/commands.ts` | Telegram commands |
| `src/moomoo/` | OAuth (`oauth.ts`) and the read-only API client (`api.ts`) |
| `src/holdings.ts`, `src/cron.ts` | Holdings sync; calendar, stop-loss checks and failure notes |
| `src/plans.ts`, `src/store.ts`, `src/time.ts` | Plan rules, D1 access, market and local time |
| `migrations/` | D1 schema |
| `test/` | Tests (run inside the Workers runtime) and fixtures |

## Deploy (push to deploy)

One-time setup; after that every push to `main` deploys.

1. **D1 database:** create it once (dashboard: Storage & Databases → D1 → Create, or `npx wrangler d1 create stock-agent`),
   and put its id in `database_id` in `wrangler.jsonc`.
2. **Connect the repo:** dashboard → Workers & Pages → stock-agent → Settings → Builds → Connect, pick this GitHub repo.
   - Build command: `npm test` (a failing test stops the deploy)
   - Deploy command: `npm run deploy` (applies D1 migrations, then deploys)
3. **Secrets:** dashboard → stock-agent → Settings → Variables and Secrets → add as type **Secret**:
   - `TELEGRAM_BOT_TOKEN` (from @BotFather)
   - `OWNER_CHAT_ID` (your private chat id)
4. **Address:** set `PUBLIC_URL` in `wrangler.jsonc` to your Worker address
   (`https://stock-agent.<you>.workers.dev`) and push.

Within a minute of each deploy the Worker sets itself up, once per address:
- registers its Telegram webhook, with a secret it generates and keeps in D1, and fills the "/" command menu;
- registers a moomoo OAuth client for its `/moomoo/callback` and keeps the client id in D1, then tells you to
  send `/moomoo`.

A failed step is retried hourly. `TELEGRAM_WEBHOOK_SECRET` and `MOOMOO_CLIENT_ID` are optional secrets that
override the generated ones. Changing `PUBLIC_URL` repeats the setup; for moomoo that means a fresh `/moomoo`
sign-in.

## Live check

In Telegram:
- `/help` answers.
- `/moomoo` connects. On moomoo’s page allow **positions and quotes only**, and leave trading **off**.
- `/sync` lists your positions.
- `/probe post /api/v1.0/quote/snapshot {"code_list":["US.MDB"]}`: run it at about 13:00, 18:00 and 06:00
  Malaysia time, and note whether `overnight_price`, `pre_price` and `after_price` are filled. If they stay 0, set
  `PRICE_HOURS` to `"regular"` in `wrangler.jsonc` and push.
- `/probe /api/v1.0/quote/trading-days?market=US&start=<today>&end=<+30d>` shows trading dates. If moomoo wants
  other parameter names, adjust `tradingDays()` in `src/moomoo/api.ts`.
- `/aitest` reports the neuron cost of one 70B call. This sizes the coming analysis pipeline.

Then replace the fixtures in `test/fixtures/` with the real, masked answers and run `npm test`.
If `/help` gets no answer, check `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` for `last_error_message`, or run
`npx wrangler tail` while you send a command.

## Limits on the free plan

- 10 ms CPU per invocation (waiting on fetch doesn't count).
- 50 outside requests per invocation; a minute uses at most a handful.
- 100,000 requests a day; the cron uses 1,440.
- moomoo allows 100 requests a minute per IP, and Cloudflare's outgoing IPs are shared.
