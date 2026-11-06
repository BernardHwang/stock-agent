# stockagent

A personal, **alert-only** stock idea agent. Every week it screens tech stocks (US first; MY/HK optional),
runs the open-source [TradingAgents](https://github.com/TauricResearch/TradingAgents) multi-agent analysis
on a few candidates, and sends trade plans to Telegram: buy zone, take-profit, stop loss, confidence,
risk/reward and reasoning. It then watches prices and news and alerts you when a level is hit.

**It never trades.** It reads your moomoo account (quotes and positions) through OpenD, read-only.
The code has no order or trade-unlock calls, and a test (`tests/test_safety.py`) fails if any appear.
You place every order yourself in the moomoo app.

> Informational only, not financial advice.

## How it works

| When (MYT) | What |
|---|---|
| Sun 10:00 | Screen the tech universe (`config/universe.yaml`, rules in `config/screener.yaml`), queue the top candidates and your `/watch` list for AI analysis |
| Mon 20:00 | Queue a review of every stock you hold |
| Every 15 min | Read your positions from moomoo; link buys to plans, close plans you sold, queue analysis for holdings without a plan |
| Every 30 min | Check news on held stocks; major news queues an urgent re-review |
| Live | Price alerts: entered buy zone, partial TP, TP, SL (each once per plan) |
| Daily | Expire unused plans after 60 days; score past plans (TP or SL first, 4/12/26-week returns) |
| Sun 21:00 | Weekly summary |

Analyses run one at a time from a priority queue: stop-loss/news re-reviews, then `/plan` requests and new
holdings, then weekly reviews, then new candidates. `MAX_RUNS_PER_DAY` caps AI usage for the free tier.

## Telegram commands

`/plan NVDA` · `/plan 0700.HK` · `/plan 0166.KL` · `/plans` · `/holdings` · `/watch TICKER` · `/unwatch TICKER` ·
`/status` · `/help`. Only your `TELEGRAM_CHAT_ID` is answered.

## Setup (local trial on Windows)

1. Install [uv](https://docs.astral.sh/uv/), then `uv sync`.
2. Telegram: create a bot with @BotFather (token) and get your chat id (e.g. message @userinfobot).
3. Gemini: create a free API key at aistudio.google.com.
4. `copy .env.example .env` and fill it in.
5. Install moomoo OpenD for Windows, log in, keep it running.
6. Check what your account can do through the API:

   ```bash
   uv run python scripts/check_permissions.py
   ```

   If US `live_subscribe` is not ok, set `PRICE_SOURCE=poll`. Add `MY`/`HK` to `MARKETS` only if they work.
7. Try one analysis: `uv run python -m stockagent.analysis NVDA`
8. Run the service: `uv run python -m stockagent`

Deploying 24/7 on Oracle Cloud's free tier: see [deploy/ORACLE_SETUP.md](deploy/ORACLE_SETUP.md).

## Development

```bash
uv run pytest
uv run ruff check .
uv run mypy src scripts
```
